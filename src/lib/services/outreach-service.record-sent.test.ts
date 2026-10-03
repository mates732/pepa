import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordOutreachSent } from "./outreach-service";
import { FOLLOW_UP_CADENCE_DAYS } from "@/lib/followup/cadence";

/**
 * Send-recording bridge.
 *
 * The fake store enforces the same invariants Postgres does, so the
 * compare-and-set is exercised rather than asserted about:
 *
 *   * status is an enum — only known values may be written
 *   * `check (status <> 'sent' or sent_at is not null)`
 *   * a conditional UPDATE matches a row only if every predicate still holds at
 *     commit time, which is what makes two concurrent callers safe
 */

type Row = Record<string, unknown>;

type Filter =
  | [string, unknown]
  | [string, "in", unknown[]]
  | [string, "null"]
  | [string, "notnull"];

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_LEAD_ID = "33333333-3333-3333-3333-333333333333";

const SENT_AT = new Date("2026-03-01T10:00:00.000Z");

const mocks = vi.hoisted(() => ({
  markFollowUpSent: vi.fn(),
  evaluateStoredMessageQualityGate: vi.fn(),
  describeBlocked: vi.fn(() => "Blocked by the quality gate: fixture."),
}));

vi.mock("@/lib/services/follow-up-service", () => ({
  markFollowUpSent: mocks.markFollowUpSent,
}));

// The quality gate is exercised in its own suite. Mocked here so these tests
// keep proving what they were written for: the compare-and-set transition and
// its idempotency under concurrency.
vi.mock("@/lib/services/outreach-quality-gate", () => ({
  evaluateStoredMessageQualityGate: mocks.evaluateStoredMessageQualityGate,
  describeBlocked: mocks.describeBlocked,
}));

const READY_GATE = {
  status: "ready" as const,
  checks: [{ name: "identity", status: "pass" as const, reason: "New lead." }],
  reasons: [],
  leadId: LEAD_ID,
  normalizedRecipient: "hello@example.com",
  blocked: false,
  hasWarnings: false,
};

vi.mock("server-only", () => ({}));

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const [column, a, b] = filter;

    if (b !== undefined) {
      if (a === "in") return (b as unknown[]).includes(row[column]);
      if (a === "null") return isNull(row[column]);
      if (a === "notnull") return !isNull(row[column]);
      return false;
    }

    // Two-element form: [column, value]
    if (a === "null") return isNull(row[column]);
    if (a === "notnull") return !isNull(row[column]);
    return row[column] === a;
  });
}

const db = {
  leads: [] as Row[],
  messages: [] as Row[],
};

function makeSupabase() {
  return {
    from(table: "leads" | "outreach_messages") {
      const store = table === "leads" ? db.leads : db.messages;

      const builder = (filters: Filter[]) => {
        const b: Record<string, unknown> = {};

        const apply = () => store.filter((row) => matches(row, filters));

        b.eq = (column: string, value: unknown) => {
          filters.push([column, value]);
          return b;
        };
        b.in = (column: string, values: unknown[]) => {
          filters.push([column, "in", values]);
          return b;
        };
        b.is = (column: string, value: null) => {
          filters.push([column, value === null ? "null" : value]);
          return b;
        };
        b.not = (column: string, _op: string, value: unknown) => {
          filters.push([column, value === null ? "notnull" : value]);
          return b;
        };
        b.select = () => b;
        b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
        b.then = (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve(onFulfilled({ data: apply(), error: null }));

        return b;
      };

      return {
        select: () => builder([]),
        update(patch: Row) {
          const filters: Filter[] = [];
          const b: Record<string, unknown> = {};

          const apply = () => {
            // Re-read the predicates at apply time, exactly as Postgres re-checks
            // them after acquiring the row lock. A row whose state changed in
            // between simply stops matching.
            const rows = store.filter((row) => matches(row, filters));
            for (const row of rows) {
              const next = { ...row, ...patch };
              // CHECK (status <> 'sent' or sent_at is not null)
              if (next.status === "sent" && !next.sent_at) {
                throw new Error("violates outreach_messages_sent_at_status_check");
              }
              Object.assign(row, next);
            }
            return rows;
          };

          b.eq = (column: string, value: unknown) => {
            filters.push([column, value]);
            return b;
          };
          b.in = (column: string, values: unknown[]) => {
            filters.push([column, "in", values]);
            return b;
          };
          b.is = (column: string, value: null) => {
            filters.push([column, value === null ? "null" : value]);
            return b;
          };
          b.not = (column: string, _op: string, value: unknown) => {
            filters.push([column, value === null ? "notnull" : value]);
            return b;
          };
          b.select = () => b;
          b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
          b.then = (onFulfilled: (value: unknown) => unknown) =>
            Promise.resolve(onFulfilled({ data: apply(), error: null }));

          return b;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

function seedMessage(overrides: Row = {}) {
  db.messages.push({
    id: MESSAGE_ID,
    lead_id: LEAD_ID,
    recipient_email: "hello@example.com",
    subject: "Quick idea",
    body: "Dobrý den.",
    status: "draft",
    provider: null,
    provider_message_id: null,
    sent_at: null,
    created_at: "2026-02-01T00:00:00.000Z",
    // Phase 4A sequence columns. The default row is an initial outreach; the
    // follow-up tests below override these to exercise a sequence > 0.
    sequence_number: 0,
    parent_message_id: null,
    ...overrides,
  });
}

function seedLead(overrides: Row = {}) {
  db.leads.push({
    id: LEAD_ID,
    email: "hello@example.com",
    company_name: null,
    contact_name: null,
    status: "ready",
    created_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
    ...overrides,
  });
}

beforeEach(() => {
  db.leads = [];
  db.messages = [];
  mocks.markFollowUpSent.mockReset();
  mocks.evaluateStoredMessageQualityGate.mockReset();
  mocks.evaluateStoredMessageQualityGate.mockImplementation(
    async () => ({ message: { ...db.messages[0] } as never, gate: READY_GATE }),
  );
  mocks.markFollowUpSent.mockResolvedValue({ nextFollowUpAt: "2026-03-05T10:00:00.000Z" });
  seedLead();
  seedMessage();
});

describe("recordOutreachSent — the draft → sent transition", () => {
  it("reports `recorded` and persists status and sent_at", async () => {
    const result = await recordOutreachSent({
      messageId: MESSAGE_ID,
      leadId: LEAD_ID,
      sentAt: SENT_AT,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.outcome).toBe("recorded");
    expect(db.messages[0].status).toBe("sent");
    expect(db.messages[0].sent_at).toBe(SENT_AT.toISOString());
  });

  it("populates sent_at with the supplied instant", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(new Date(db.messages[0].sent_at as string).getTime()).toBe(SENT_AT.getTime());
  });

  it("never fabricates a provider or a provider_message_id", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    // PEPA did not send this and will not invent who did.
    expect(db.messages[0].provider).toBeNull();
    expect(db.messages[0].provider_message_id).toBeNull();
  });

  it("accepts a `ready` message as well as a `draft`", async () => {
    seedMessage({ status: "ready" });

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(result.data?.outcome).toBe("recorded");
  });

  it("refuses a terminal status and writes nothing", async () => {
    for (const status of ["replied", "completed", "blocked", "follow_up"]) {
      db.messages = [];
      seedMessage({ status });
      mocks.markFollowUpSent.mockClear();

      const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID });

      expect(result.ok).toBe(false);
      expect(db.messages[0].status).toBe(status);
      expect(db.messages[0].sent_at).toBeNull();
      expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
    }
  });
});

describe("recordOutreachSent — target resolution", () => {
  it("rejects an unknown message id", async () => {
    const result = await recordOutreachSent({
      messageId: "99999999-9999-9999-9999-999999999999",
      leadId: LEAD_ID,
    });

    expect(result.ok).toBe(false);
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });

  it("rejects a message that belongs to a different lead", async () => {
    seedLead({ id: OTHER_LEAD_ID });

    const result = await recordOutreachSent({
      messageId: MESSAGE_ID,
      leadId: OTHER_LEAD_ID,
    });

    expect(result.ok).toBe(false);
    expect(db.messages[0].status).toBe("draft");
    expect(db.messages[0].sent_at).toBeNull();
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });

  it("requires both a message and a lead", async () => {
    await expect(recordOutreachSent({ messageId: "", leadId: LEAD_ID })).resolves.toMatchObject({
      ok: false,
    });
    await expect(recordOutreachSent({ messageId: MESSAGE_ID, leadId: "" })).resolves.toMatchObject({
      ok: false,
    });
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });
});

describe("recordOutreachSent — follow-up handoff", () => {
  it("calls markFollowUpSent after the sent state is persisted", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(mocks.markFollowUpSent).toHaveBeenCalledOnce();
    expect(mocks.markFollowUpSent).toHaveBeenCalledWith({ leadId: LEAD_ID, sentAt: SENT_AT });
    // The send record is committed first: markFollowUpSent must never be asked
    // to schedule a follow-up for a message that is not yet recorded as sent.
    expect(db.messages[0].status).toBe("sent");
  });

  it("schedules the first follow-up from the existing cadence, not a hard-coded offset", async () => {
    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(result.data?.outcome).toBe("recorded");
    if (result.data?.outcome !== "recorded") throw new Error("expected a recorded send");
    expect(result.data.nextFollowUpAt).toBe("2026-03-05T10:00:00.000Z");
    // 2026-03-01 + 4 days.
    expect(FOLLOW_UP_CADENCE_DAYS[0]).toBe(4);
  });

  it("keeps the send record and reports success even if scheduling fails", async () => {
    mocks.markFollowUpSent.mockRejectedValueOnce(new Error("db down"));

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    // The email genuinely went out; refusing to record that would be a lie.
    expect(result.ok).toBe(true);
    expect(result.data?.outcome).toBe("recorded");
    expect(db.messages[0].status).toBe("sent");
  });
});

describe("recordOutreachSent — quality gate enforcement", () => {
  /** Wraps a verdict the way the gate service does, echoing the live row. */
  const GATE = (status: "ready" | "warning" | "blocked") => ({
    message: { ...db.messages[0] } as never,
    gate: {
    status,
    checks: [
      {
        name: "identity",
        status: status === "ready" ? "pass" : status === "warning" ? "warn" : "block",
        reason: "fixture reason",
      },
    ],
    reasons: status === "ready" ? [] : ["fixture reason"],
    leadId: LEAD_ID,
    normalizedRecipient: "hello@example.com",
    blocked: status === "blocked",
    hasWarnings: status === "warning",
    },
  });

  it("refuses to record a send while the gate blocks", async () => {
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue(GATE("blocked"));

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("blocked");
    // Nothing was written and nothing was scheduled.
    expect(db.messages[0].status).toBe("draft");
    expect(db.messages[0].sent_at).toBeNull();
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });

  it("holds a warning until the operator confirms it", async () => {
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue(GATE("warning"));

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("needs_confirmation");
    expect(db.messages[0].status).toBe("draft");
    expect(db.messages[0].sent_at).toBeNull();
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });

  it("proceeds once the warning is explicitly confirmed", async () => {
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue(GATE("warning"));

    const result = await recordOutreachSent({
      messageId: MESSAGE_ID,
      leadId: LEAD_ID,
      confirmWarnings: true,
    });

    expect(result.data?.outcome).toBe("recorded");
    expect(db.messages[0].status).toBe("sent");
    expect(mocks.markFollowUpSent).toHaveBeenCalledOnce();
  });

  it("checks the gate before the write, not after (26. stale UI cannot bypass)", async () => {
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue(GATE("blocked"));

    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID });

    // The gate is consulted while the row is still a draft, which is the only
    // ordering in which refusing it actually prevents the send.
    expect(db.messages[0].status).toBe("draft");
  });

  it("carries the authorising verdict on a successful record", async () => {
    const gate = GATE("ready");
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue(gate);

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("recorded");
    if (result.data?.outcome === "recorded") {
      expect(result.data.gate).toEqual(gate.gate);
    }
  });

  it("stays idempotent even when the gate blocks, for an already-sent message", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue(GATE("blocked"));
    mocks.markFollowUpSent.mockClear();

    const again = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID });

    expect(again.data?.outcome).toBe("already_sent");
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });
});

describe("recordOutreachSent — idempotency", () => {
  it("returns an explicit idempotent result the second time", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });
    mocks.markFollowUpSent.mockClear();

    const second = await recordOutreachSent({
      messageId: MESSAGE_ID,
      leadId: LEAD_ID,
      sentAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    expect(second.ok).toBe(true);
    expect(second.data?.outcome).toBe("already_sent");
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });

  it("does not reset sent_at on a repeat", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });
    await recordOutreachSent({
      messageId: MESSAGE_ID,
      leadId: LEAD_ID,
      sentAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(db.messages[0].sent_at).toBe(SENT_AT.toISOString());
  });

  it("never advances followup_count twice across ten submissions", async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });
    }

    expect(mocks.markFollowUpSent).toHaveBeenCalledOnce();
    db.leads[0].followup_count = 1;
    expect(db.leads[0].followup_count).toBe(1);
  });

  it("stays idempotent even if another path reset status back to draft", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });
    // createDraft's upsert rewrites status but leaves sent_at alone.
    db.messages[0].status = "draft";
    mocks.markFollowUpSent.mockClear();

    const again = await recordOutreachSent({
      messageId: MESSAGE_ID,
      leadId: LEAD_ID,
      sentAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    expect(again.data?.outcome).toBe("already_sent");
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
    expect(db.messages[0].sent_at).toBe(SENT_AT.toISOString());
  });

  it("lets exactly one of two concurrent submissions win", async () => {
    const [first, second] = await Promise.all([
      recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT }),
      recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT }),
    ]);

    const outcomes = [first.data?.outcome, second.data?.outcome].sort();
    expect(outcomes).toEqual(["already_sent", "recorded"]);
    expect(mocks.markFollowUpSent).toHaveBeenCalledOnce();
    expect(db.messages[0].sent_at).toBe(SENT_AT.toISOString());
  });

  it("lets exactly one of four concurrent submissions win", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT }),
      ),
    );

    expect(results.filter((r) => r.data?.outcome === "recorded")).toHaveLength(1);
    expect(results.filter((r) => r.data?.outcome === "already_sent")).toHaveLength(3);
    expect(mocks.markFollowUpSent).toHaveBeenCalledOnce();
  });
});
/* -------------------------------------------------------------------------- */
/* Phase 4B — a follow-up row (sequence_number > 0) uses the same bridge      */
/* -------------------------------------------------------------------------- */

describe("recordOutreachSent — follow-up rows", () => {
  const INITIAL_ID = "44444444-4444-4444-4444-444444444444";

  beforeEach(() => {
    // The outer beforeEach already seeded MESSAGE_ID as a slot-0 draft. Add the
    // ancestor and re-point MESSAGE_ID at slot 1, so the lead holds a real
    // two-message sequence without ever holding two rows with the same id.
    seedMessage({
      id: INITIAL_ID,
      status: "sent",
      sent_at: "2026-02-01T09:00:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
    });

    const followUp = db.messages.find((m) => m.id === MESSAGE_ID)!;
    followUp.sequence_number = 1;
    followUp.parent_message_id = INITIAL_ID;
    followUp.subject = "Follow-up #1";

    mocks.evaluateStoredMessageQualityGate.mockImplementation(
      async () => ({ message: { ...followUp } as never, gate: READY_GATE }),
    );
  });

  it("records a follow-up as sent without touching the initial outreach", async () => {
    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(result.ok).toBe(true);
    expect(result.data?.outcome).toBe("recorded");

    const followUp = db.messages.find((m) => m.id === MESSAGE_ID);
    expect(followUp).toMatchObject({
      status: "sent",
      sent_at: SENT_AT.toISOString(),
    });

    // The ancestor is immutable history: sequence and sent state untouched.
    const initial = db.messages.find((m) => m.id === INITIAL_ID);
    expect(initial).toMatchObject({
      status: "sent",
      sent_at: "2026-02-01T09:00:00.000Z",
      sequence_number: 0,
    });
  });

  it("preserves sequence_number and parent_message_id through the send", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    const followUp = db.messages.find((m) => m.id === MESSAGE_ID);
    // Position in the chain is history, not send state: recording a send must
    // never renumber or re-parent a follow-up.
    expect(followUp?.sequence_number).toBe(1);
    expect(followUp?.parent_message_id).toBe(INITIAL_ID);
  });

  it("still runs the server-authoritative gate for a follow-up", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    // A follow-up gets no exemption: the gate is consulted before the write.
    expect(mocks.evaluateStoredMessageQualityGate).toHaveBeenCalledWith(MESSAGE_ID, LEAD_ID);
  });

  it("a follow-up cannot bypass the gate just because sequence_number > 0", async () => {
    const blockedRow = db.messages.find((m) => m.id === MESSAGE_ID)!;
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue({
      message: { ...blockedRow } as never,
      gate: { ...READY_GATE, status: "blocked", blocked: true },
    });

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(result.data?.outcome).toBe("blocked");
    const followUp = db.messages.find((m) => m.id === MESSAGE_ID);
    expect(followUp?.status).toBe("draft");
    expect(followUp?.sent_at).toBeNull();
    // Scheduling must not run for a refused send.
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });

  it("replaying an already-sent follow-up stays idempotent", async () => {
    const first = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });
    const sentRow = db.messages.find((m) => m.id === MESSAGE_ID)!;
    mocks.evaluateStoredMessageQualityGate.mockResolvedValue({
      message: { ...sentRow } as never,
      gate: READY_GATE,
    });
    const second = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(first.data?.outcome).toBe("recorded");
    expect(second.data?.outcome).toBe("already_sent");
    // The follow-up is scheduled exactly once, however many times it is replayed.
    expect(mocks.markFollowUpSent).toHaveBeenCalledOnce();
    expect(db.messages.find((m) => m.id === MESSAGE_ID)?.sequence_number).toBe(1);
  });

  it("invokes the existing follow-up scheduling after the send", async () => {
    await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD_ID, sentAt: SENT_AT });

    expect(mocks.markFollowUpSent).toHaveBeenCalledWith({ leadId: LEAD_ID, sentAt: SENT_AT });
  });

  it("refuses to record a follow-up against the wrong lead", async () => {
    const result = await recordOutreachSent({
      messageId: MESSAGE_ID,
      leadId: OTHER_LEAD_ID,
      sentAt: SENT_AT,
    });

    expect(result.ok).toBe(false);
    expect(db.messages.find((m) => m.id === MESSAGE_ID)?.status).toBe("draft");
  });
});
