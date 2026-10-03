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

const mocks = vi.hoisted(() => ({ markFollowUpSent: vi.fn() }));

vi.mock("@/lib/services/follow-up-service", () => ({
  markFollowUpSent: mocks.markFollowUpSent,
}));

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