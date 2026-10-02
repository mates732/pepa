import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIM_LEASE_MS, processDueFollowUps, type ActionNotifier } from "./follow-up-service";

/**
 * Engine tests against an in-memory store that enforces the same unique
 * constraint Postgres does (`unique (lead_id, followup_number)`), so idempotency
 * and concurrent-claim behaviour are genuinely exercised rather than mocked
 * away. The SQL side is additionally verified against a real Postgres instance.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase } = vi.hoisted(() => {
  const db = {
    dueFollowups: [] as Row[],
    notifications: [] as Row[],
    tokens: [] as Row[],
    leads: [] as Row[],
    /** Makes markNotified() fail, i.e. a send that cannot be booked. */
    failBookkeeping: false,
  };

  /** Supabase table name -> store. */
  const TABLES = {
    due_followups: "dueFollowups",
    followup_notifications: "notifications",
    action_tokens: "tokens",
    leads: "leads",
  } as const;

  type Table = keyof typeof TABLES;

  let nextId = 1;
  const reset = () => {
    nextId = 1;
    db.dueFollowups = [];
    db.notifications = [];
    db.tokens = [];
    db.leads = [];
  };

  function builder(table: Table, filters: Array<[string, unknown]>) {
    const matched = () =>
      (db[TABLES[table]] as Row[]).filter((row) =>
        filters.every(([column, value]) =>
          Array.isArray(value) ? value.includes(row[column]) : row[column] === value,
        ),
      );

    const b: Record<string, unknown> = {};
    b.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return b;
    };
    b.order = () => b;
    b.limit = () => b;
    b.select = () => b;
    b.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    b.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve({ data: matched(), error: null }).then(onFulfilled);
    return b;
  }

  /** insert() with `.select().maybeSingle()` chaining, honouring the unique key. */
  function insertBuilder(table: Table, rows: Row[]) {
    const b: Record<string, unknown> = {};

    const attempt = () => {
      // Yield so two concurrent claims really overlap before the constraint bites.
      return new Promise<{ data: Row[]; error: null } | { data: null; error: { code: string; message: string } }>(
        (resolve) => {
          setTimeout(() => {
            for (const row of rows) {
              if (table === "followup_notifications") {
                const clash = db.notifications.find(
                  (existing) =>
                    existing.lead_id === row.lead_id &&
                    existing.followup_number === row.followup_number,
                );
                if (clash) {
                  resolve({
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  });
                  return;
                }
              }
              (db[TABLES[table]] as Row[]).push({ id: `row-${(nextId += 1)}`, ...row });
            }
            resolve({ data: rows.map((_, i) => ({ id: `row-${(nextId -= i)}` })), error: null });
          }, 0);
        },
      );
    };

    b.select = () => b;
    b.maybeSingle = async () => {
      const result = await attempt();
      return result.error ? result : { data: rows[0] ?? null, error: null };
    };
    b.then = async (onFulfilled: (value: unknown) => unknown) => onFulfilled(await attempt());
    return b;
  }

  function makeSupabase() {
    return {
      from(table: Table) {
        return {
          select: () => builder(table, []),

          insert(payload: Row | Row[]) {
            return insertBuilder(table, Array.isArray(payload) ? payload : [payload]);
          },

          update(patch: Row) {
            const filters: Array<[string, unknown]> = [];
            const b: Record<string, unknown> = {};
            const apply = () => {
              const rows = (db[TABLES[table]] as Row[]).filter((row) =>
                filters.every(([column, value]) => row[column] === value),
              );
              rows.forEach((row) => Object.assign(row, patch));
              return rows;
            };
            if (db.failBookkeeping && patch.status === "sent") {
              return {
                ...b,
                select: () => b,
                maybeSingle: async () => ({
                  data: null,
                  error: { code: "PGRST116", message: "bookkeeping unavailable" },
                }),
                then: async (onFulfilled: (value: unknown) => unknown) =>
                  onFulfilled({ data: null, error: { message: "bookkeeping unavailable" } }),
              };
            }
            b.eq = (column: string, value: unknown) => {
              filters.push([column, value]);
              return b;
            };
            b.select = () => b;
            b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
            b.then = async (onFulfilled: (value: unknown) => unknown) =>
              onFulfilled({ data: apply(), error: null });
            return b;
          },

          delete() {
            const filters: Array<[string, unknown]> = [];
            const b: Record<string, unknown> = {};
            b.eq = (column: string, value: unknown) => {
              filters.push([column, value]);
              return b;
            };
            b.select = () => b;
            b.maybeSingle = async () => ({ data: null, error: null });
            b.then = async (onFulfilled: (value: unknown) => unknown) => {
              const doomed = (db[TABLES[table]] as Row[]).filter((row) =>
                filters.every(([column, value]) => row[column] === value),
              );
              db[TABLES[table]] = (db[TABLES[table]] as Row[]).filter(
                (row) => !doomed.includes(row),
              );
              return onFulfilled({ data: doomed, error: null });
            };
            return b;
          },
        };
      },
    };
  }

  reset();
  return { db, makeSupabase: () => makeSupabase() };
});

let minted = 0;

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

vi.mock("@/lib/services/action-token-service", () => ({
  mintFollowUpToken: async ({
    leadId,
    outreachId,
  }: {
    leadId: string;
    outreachId?: string | null;
  }) => {
    const tokenId = `token-${(minted += 1)}`;
    db.tokens.push({ id: tokenId, lead_id: leadId, outreach_id: outreachId });
    return {
      ok: true,
      error: null,
      data: {
        token: `fp1_test${String(minted).padStart(39, "0")}`,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        id: tokenId,
      },
    };
  },
}));

vi.mock("@/lib/config/base-url", () => ({
  buildDeepLink: async (token: string) => `https://pepa.example.com/followup/${token}`,
  getBaseUrl: async () => "https://pepa.example.com",
}));

const notifications: Array<{ title: string; body: string; actionLabel: string; actionUrl: string }> = [];
let failNextSend = false;

const notifier: ActionNotifier = {
  async sendActionNotification(notification) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("Telegram delivery failed: 502");
    }
    notifications.push({ ...notification });
  },
};

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const OUTREACH_ID = "22222222-2222-2222-2222-222222222222";

function seedDueFollowUp(overrides: Partial<Row> = {}) {
  const row = {
    lead_id: LEAD_ID,
    email: "hello@example.cz",
    company_name: "Example Business",
    contact_name: null,
    lead_status: "sent",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
    last_contacted_at: "2026-09-28T00:00:00.000Z",
    next_followup_at: "2026-10-01T08:00:00.000Z",
    followup_count: 0,
    outreach_id: OUTREACH_ID,
    recipient_email: "hello@example.cz",
    subject: "AI recepce pro Example",
    body: "Dobrý den,...",
    outreach_status: "sent",
    sent_at: "2026-09-28T00:00:00.000Z",
    outreach_created_at: "2026-09-28T00:00:00.000Z",
    followup_number: 1,
    ...overrides,
  };
  db.dueFollowups.push(row);
  db.leads.push({
    id: LEAD_ID,
    followup_count: 0,
    next_followup_at: "2026-10-01T08:00:00.000Z",
    ...overrides,
  });
  return row;
}

beforeEach(() => {
  minted = 0;
  notifications.length = 0;
  failNextSend = false;
  db.dueFollowups = [];
  db.notifications = [];
  db.tokens = [];
  db.leads = [];
  db.failBookkeeping = false;
});

describe("processDueFollowUps — due selection", () => {
  it("examines nothing when the due view is empty (future follow-ups excluded in SQL)", async () => {
    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.examined).toBe(0);
    expect(outcome.notified).toBe(0);
  });

  it("notifies a due follow-up", async () => {
    seedDueFollowUp();

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.examined).toBe(1);
    expect(outcome.notified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(outcome.failed).toBe(0);
  });

  it("renders the operator-facing surface with an opaque deep link", async () => {
    seedDueFollowUp();

    await processDueFollowUps({ notifier });
    const [message] = notifications;

    expect(message.title).toBe("🔥 FOLLOW-UP DUE");
    expect(message.body).toContain("Example Business");
    expect(message.body).toContain("Follow-up #1");
    expect(message.actionLabel).toBe("OPEN IN PEPA");
    expect(message.actionUrl).toMatch(/^https:\/\/pepa\.example\.com\/followup\/fp1_/);
  });

  it("never puts subject or body in the notification", async () => {
    seedDueFollowUp();

    await processDueFollowUps({ notifier });
    const text = notifications[0].title + notifications[0].body + notifications[0].actionUrl;

    expect(text).not.toContain("AI recepce");
    expect(text).not.toContain("Dobrý den");
  });

  it("falls back to the email when there is no company name", async () => {
    seedDueFollowUp({ company_name: null });
    await processDueFollowUps({ notifier });
    expect(notifications[0].body).toContain("hello@example.cz");
  });

  it("ignores follow-up #4 and clears the exhausted schedule", async () => {
    seedDueFollowUp({ followup_count: 3, followup_number: 4 });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.skippedMaxCadence).toBe(1);
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(db.leads[0].next_followup_at).toBeNull();
  });

  it("notifies follow-up #3", async () => {
    seedDueFollowUp({ followup_count: 2, followup_number: 3 });
    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.notified).toBe(1);
    expect(notifications[0].body).toContain("Follow-up #3");
  });

  it("never advances next_followup_at — only markFollowUpSent does", async () => {
    seedDueFollowUp();

    await processDueFollowUps({ notifier });
    expect(db.leads[0].next_followup_at).toBe("2026-10-01T08:00:00.000Z");
    expect(db.leads[0].followup_count).toBe(0);
  });
});

describe("processDueFollowUps — idempotency", () => {
  it("a second run sends nothing further", async () => {
    seedDueFollowUp();

    const first = await processDueFollowUps({ notifier });
    const second = await processDueFollowUps({ notifier });

    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    expect(second.skippedAlreadyNotified).toBe(1);
    expect(notifications).toHaveLength(1);
  });

  it("five consecutive runs produce exactly one notification", async () => {
    seedDueFollowUp();

    for (let i = 0; i < 5; i += 1) {
      await processDueFollowUps({ notifier });
    }

    expect(notifications).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].status).toBe("sent");
  });

  it("records the deep link and its token against the notification", async () => {
    seedDueFollowUp();
    await processDueFollowUps({ notifier });

    const [row] = db.notifications;
    expect(row.lead_id).toBe(LEAD_ID);
    expect(row.followup_number).toBe(1);
    expect(row.status).toBe("sent");
    expect(row.sent_at).toBeTruthy();
    expect(row.action_token_id).toBe("token-1");
    // The token is minted server-side, bound to lead + outreach.
    expect(db.tokens[0].lead_id).toBe(LEAD_ID);
    expect(db.tokens[0].outreach_id).toBe(OUTREACH_ID);
  });

  it("treats an in-flight claim from another worker as busy", async () => {
    seedDueFollowUp();
    db.notifications.push({
      lead_id: LEAD_ID,
      outreach_id: OUTREACH_ID,
      followup_number: 1,
      status: "claimed",
      claimed_at: new Date().toISOString(),
      sent_at: null,
    });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.skippedBusy).toBe(1);
    expect(notifications).toHaveLength(0);
  });

  it("reclaims a claim left behind by a crashed worker once the lease expires", async () => {
    seedDueFollowUp();
    db.notifications.push({
      lead_id: LEAD_ID,
      outreach_id: OUTREACH_ID,
      followup_number: 1,
      status: "claimed",
      claimed_at: new Date(Date.now() - CLAIM_LEASE_MS - 1000).toISOString(),
      sent_at: null,
    });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].status).toBe("sent");
  });
});

describe("processDueFollowUps — concurrency", () => {
  it("two concurrent runs send exactly one notification", async () => {
    seedDueFollowUp();

    const [a, b] = await Promise.all([
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
    ]);

    expect(notifications).toHaveLength(1);
    expect(a.notified + b.notified).toBe(1);
    // The loser either loses the INSERT race (-> busy) or arrives after the
    // winner already booked it (-> already notified). Either way: one send.
    expect(a.skippedBusy + b.skippedBusy + a.skippedAlreadyNotified + b.skippedAlreadyNotified).toBe(1);
    expect(db.notifications).toHaveLength(1);
  });

  it("four concurrent runs still send exactly one notification", async () => {
    seedDueFollowUp();

    const results = await Promise.all([
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
    ]);

    expect(notifications).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.notified, 0)).toBe(1);
    expect(db.notifications).toHaveLength(1);
  });
});

describe("processDueFollowUps — failure handling", () => {
  it("releases the claim when Telegram fails, so a later run retries", async () => {
    seedDueFollowUp();
    failNextSend = true;

    const failed = await processDueFollowUps({ notifier });
    expect(failed.failed).toBe(1);
    expect(failed.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);

    const retry = await processDueFollowUps({ notifier });
    expect(retry.notified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
  });

  it("keeps the claim when the send succeeded but bookkeeping failed", async () => {
    seedDueFollowUp();
    db.failBookkeeping = true;

    // The message really goes out; only the ledger update fails.
    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.failed).toBe(1);
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(1);

    // The claim survives, so an immediate re-run cannot double-send.
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0].status).toBe("claimed");

    const again = await processDueFollowUps({ notifier });
    expect(again.notified).toBe(0);
    expect(again.skippedBusy).toBe(1);
    expect(notifications).toHaveLength(1);
  });

  it("re-notifies after the lease expires if bookkeeping never succeeded", async () => {
    seedDueFollowUp();
    db.failBookkeeping = true;
    await processDueFollowUps({ notifier });
    expect(notifications).toHaveLength(1);

    // Simulate the lease aging out between runs.
    db.notifications[0].claimed_at = new Date(Date.now() - CLAIM_LEASE_MS - 1000).toISOString();

    db.failBookkeeping = false;
    const later = await processDueFollowUps({ notifier });
    expect(later.notified).toBe(1);
    expect(notifications).toHaveLength(2);
    expect(db.notifications[0].status).toBe("sent");
  });

  it("counts a failure without aborting the remaining follow-ups", async () => {
    seedDueFollowUp();
    db.dueFollowups.push({
      ...db.dueFollowups[0],
      lead_id: "33333333-3333-3333-3333-333333333333",
      outreach_id: "44444444-4444-4444-4444-444444444444",
      followup_number: 1,
    });
    db.leads.push({
      id: "33333333-3333-3333-3333-333333333333",
      followup_count: 0,
      next_followup_at: "2026-10-01T08:00:00.000Z",
    });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.examined).toBe(2);
    expect(outcome.notified).toBe(2);
  });

  it("fails safely when no notification channel is configured", async () => {
    seedDueFollowUp();

    const outcome = await processDueFollowUps({ notifier: undefined });
    expect(outcome.notified).toBe(0);
    expect(outcome.failed).toBe(1);
    expect(db.notifications).toHaveLength(0);
  });
});