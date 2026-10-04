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
    /** Phase 8A: the real sequence rows a notification can point at. */
    messages: [] as Row[],
    /** Makes markNotified() fail, i.e. a send that cannot be booked. */
    failBookkeeping: false,
  };

  /** Supabase table name -> store. */
  const TABLES = {
    due_followups: "dueFollowups",
    followup_notifications: "notifications",
    action_tokens: "tokens",
    leads: "leads",
    outreach_messages: "messages",
  } as const;

  type Table = keyof typeof TABLES;

  let nextId = 1;
  const reset = () => {
    nextId = 1;
    db.dueFollowups = [];
    db.notifications = [];
    db.tokens = [];
    db.leads = [];
    db.messages = [];
  };

  type Filter = { column: string; op: "eq" | "in" | "is" | "gt"; value: unknown };

  function builder(table: Table, filters: Filter[]) {
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;

    const matched = () => {
      const filtered = (db[TABLES[table]] as Row[]).filter((row) =>
        filters.every(({ column, op, value }) => {
          if (op === "eq") return row[column] === value;
          if (op === "is") return value === null ? (row[column] ?? null) === null : row[column] === value;
          if (op === "in") return (value as unknown[]).includes(row[column]);
          return Number(row[column] ?? Number.NEGATIVE_INFINITY) > Number(value);
        }),
      );
      // PostgREST applies ORDER BY before LIMIT, and the Phase 8A resolution
      // depends on it: "the highest open sequence row" is only correct if the
      // fake actually sorts.
      if (order) {
        const direction = order.ascending ? 1 : -1;
        filtered.sort((a, b) => {
          const av = Number(a[order!.column] ?? 0);
          const bv = Number(b[order!.column] ?? 0);
          return (av - bv) * direction;
        });
      }
      return limit === null ? filtered : filtered.slice(0, limit);
    };

    const b: Record<string, unknown> = {};
    b.eq = (column: string, value: unknown) => {
      filters.push({ column, op: "eq", value });
      return b;
    };
    b.in = (column: string, value: unknown[]) => {
      filters.push({ column, op: "in", value });
      return b;
    };
    b.is = (column: string, value: unknown) => {
      filters.push({ column, op: "is", value });
      return b;
    };
    b.gt = (column: string, value: number) => {
      filters.push({ column, op: "gt", value });
      return b;
    };
    b.order = (column: string, options?: { ascending?: boolean }) => {
      order = { column, ascending: options?.ascending ?? true };
      return b;
    };
    b.limit = (count: number) => {
      limit = count;
      return b;
    };
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
/** The already-sent initial outreach the due view anchors on. */
const OUTREACH_ID = "22222222-2222-2222-2222-222222222222";
/** The real, stored follow-up row a Phase 8A notification points at. */
const FOLLOW_UP_ID = "55555555-5555-5555-5555-555555555555";

/**
 * The stored follow-up the notification is about.
 *
 * Defaults to an open (draft) child of the anchor at slot 1, which is the only
 * shape that may be notified at all. `overrides` are merged so a test can make
 * it already sent, or put it at a different slot.
 */
function seedFollowUpRow(overrides: Partial<Row> = {}): Row {
  const row = {
    id: FOLLOW_UP_ID,
    lead_id: LEAD_ID,
    recipient_email: "hello@example.cz",
    subject: "AI recepce pro Example",
    body: "Dobrý den,...",
    status: "draft",
    provider: null,
    provider_message_id: null,
    sent_at: null,
    created_at: "2026-09-29T00:00:00.000Z",
    sequence_number: 1,
    parent_message_id: OUTREACH_ID,
    ...overrides,
  };
  db.messages.push(row);
  return row;
}

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
  // Scheduling alone never justifies a notification: the follow-up row itself
  // must exist, so the default seed always stores one.
  seedFollowUpRow({ sequence_number: Number(row.followup_number) });
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
  db.messages = [];
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
    // The token is minted server-side and bound to the exact follow-up row, so
    // the link, the ledger and the operator all land on the same message.
    expect(db.tokens[0].lead_id).toBe(LEAD_ID);
    expect(db.tokens[0].outreach_id).toBe(FOLLOW_UP_ID);
    expect(row.outreach_id).toBe(FOLLOW_UP_ID);
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
    seedFollowUpRow({
      id: "66666666-6666-6666-6666-666666666666",
      lead_id: "33333333-3333-3333-3333-333333333333",
      parent_message_id: "44444444-4444-4444-4444-444444444444",
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

describe("notification channel wiring", () => {
  // Regression: the scheduler used to read the bare registry, which returns
  // null unless something else happened to import the registration module. The
  // cron route imports nothing else, so in production every due follow-up
  // silently counted as `failed` and no Telegram message was ever sent.
  it("registers the Telegram channel merely by importing the service", async () => {
    const { getNotificationService } = await import("@/lib/providers/registry");
    expect(getNotificationService("telegram")?.id).toBe("telegram");
  });

  it("resolves a channel for the scheduler even without Telegram credentials", async () => {
    // Registration is unconditional; only `isConfigured()` flips. The send then
    // throws and the claim is released, which is what keeps it retryable.
    const { getNotificationChannel } = await import("@/lib/providers/notifications");
    const channel = getNotificationChannel();

    expect(channel).not.toBeNull();
    expect(channel?.isConfigured()).toBe(false);
  });

  it("counts an unconfigured channel as retryable, not as notified", async () => {
    seedDueFollowUp();
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;

    try {
      const outcome = await processDueFollowUps();
      expect(outcome.notified).toBe(0);
      expect(outcome.failed).toBe(1);
      expect(db.notifications).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.TELEGRAM_BOT_TOKEN = previous;
    }
  });
});

describe("Phase 8A — due follow-up resolution to a real message", () => {
  it("resolves a due lead to its stored follow-up row, not the anchor", async () => {
    seedDueFollowUp();

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(1);

    // The ledger names the follow-up row, never the already-sent anchor.
    const [row] = db.notifications;
    expect(row.outreach_id).toBe(FOLLOW_UP_ID);
    expect(row.outreach_id).not.toBe(OUTREACH_ID);
  });

  it("takes the follow-up number from sequence_number, not followup_count + 1", async () => {
    // Unrecorded history: the counter claims two follow-ups went out that were
    // never stored, so the stored follow-up really IS follow-up #1.
    seedDueFollowUp({ followup_count: 2, followup_number: 3 });
    db.messages[0].sequence_number = 1;

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(1);
    expect(notifications[0].body).toContain("Follow-up #1");
    expect(db.notifications[0].followup_number).toBe(1);
  });

  it("notifies the highest open sequence slot when several follow-ups are open", async () => {
    seedDueFollowUp();
    // A second, later follow-up that is already out; the open one is still #1.
    seedFollowUpRow({ id: "77777777-7777-7777-7777-777777777777", sequence_number: 2, status: "sent", sent_at: "2026-09-30T00:00:00.000Z" });
    seedFollowUpRow({ id: "88888888-8888-8888-8888-888888888888", sequence_number: 3 });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(1);
    expect(notifications[0].body).toContain("Follow-up #3");
    expect(db.notifications[0].outreach_id).toBe("88888888-8888-8888-8888-888888888888");
  });

  it("uses the notified row's own recipient", async () => {
    seedDueFollowUp();
    db.messages[0].recipient_email = "hello@example.cz";

    await processDueFollowUps({ notifier });
    expect(notifications[0].body).toContain("hello@example.cz");
  });

  it("excludes a follow-up that was already sent", async () => {
    seedDueFollowUp();
    db.messages[0].status = "sent";
    db.messages[0].sent_at = "2026-09-30T09:00:00.000Z";

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedAlreadySent).toBe(1);
    expect(notifications).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });

  it("excludes a follow-up row that no longer exists (unrecorded history)", async () => {
    // Scheduling says due, the counter claims follow-ups were sent, but the
    // sequence holds nothing: nothing may be fabricated from that.
    seedDueFollowUp({ followup_count: 2 });
    db.messages.length = 0;

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedUnrecorded).toBe(1);
    expect(notifications).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
  });

  it("ignores a follow-up belonging to a different lead", async () => {
    seedDueFollowUp();
    db.messages[0].lead_id = "99999999-9999-9999-9999-999999999999";

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedUnrecorded).toBe(1);
    expect(notifications).toHaveLength(0);
  });

  it("ignores an initial outreach (sequence 0) as a notification target", async () => {
    seedDueFollowUp();
    db.messages[0].sequence_number = 0;

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedUnrecorded).toBe(1);
  });

  it("sends nothing when two recipients share a sequence slot", async () => {
    // The ledger is keyed (lead, follow-up number) and cannot separate these.
    seedDueFollowUp();
    seedFollowUpRow({ id: "aaaa1111-1111-1111-1111-111111111111", recipient_email: "other@example.cz" });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedAmbiguous).toBe(1);
    expect(notifications).toHaveLength(0);
  });
});

describe("Phase 8A — ledger identity and duplicate suppression", () => {
  it("keys the ledger by the notified message's sequence", async () => {
    seedDueFollowUp();
    await processDueFollowUps({ notifier });

    expect(db.notifications).toHaveLength(1);
    const [row] = db.notifications;
    expect(row.followup_number).toBe(1);
    expect(row.outreach_id).toBe(FOLLOW_UP_ID);
  });

  it("does not re-notify a follow-up already booked under the old counter numbering", async () => {
    // A ledger row written before Phase 8A: followup_count + 1 == 3.
    seedDueFollowUp({ followup_count: 2, followup_number: 3 });
    db.notifications.push({
      lead_id: LEAD_ID,
      outreach_id: OUTREACH_ID,
      followup_number: 3,
      status: "sent",
      claimed_at: "2026-09-30T00:00:00.000Z",
      sent_at: "2026-09-30T00:00:00.000Z",
    });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedAlreadyNotified).toBe(1);
    expect(notifications).toHaveLength(0);
    // Nothing new was written: the existing row is left exactly as it was.
    expect(db.notifications).toHaveLength(1);
  });

  it("still ignores a stale claim row that was never delivered", async () => {
    seedDueFollowUp({ followup_count: 2, followup_number: 3 });
    db.messages[0].sequence_number = 1;
    db.notifications.push({
      lead_id: LEAD_ID,
      outreach_id: OUTREACH_ID,
      followup_number: 3,
      status: "claimed",
      claimed_at: new Date().toISOString(),
      sent_at: null,
    });

    // The legacy row was never sent, so it must not suppress a real notification.
    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(1);
  });

  it("three consecutive runs produce exactly one notification event", async () => {
    seedDueFollowUp();

    await processDueFollowUps({ notifier });
    await processDueFollowUps({ notifier });
    await processDueFollowUps({ notifier });

    expect(notifications).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
  });

  it("handles a duplicate ledger insert as a conflict, not a second send", async () => {
    seedDueFollowUp();
    db.notifications.push({
      lead_id: LEAD_ID,
      outreach_id: FOLLOW_UP_ID,
      followup_number: 1,
      status: "claimed",
      claimed_at: new Date().toISOString(),
      sent_at: null,
    });

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedBusy).toBe(1);
    expect(notifications).toHaveLength(0);
  });

  it("four concurrent runs still send one notification for one follow-up row", async () => {
    seedDueFollowUp();

    await Promise.all([
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
    ]);

    expect(notifications).toHaveLength(1);
    expect(db.notifications).toHaveLength(1);
  });
});

describe("Phase 8A — notification surface and security", () => {
  it("announces attention, never a send", async () => {
    seedDueFollowUp();
    await processDueFollowUps({ notifier });

    const text = `${notifications[0].title}\n${notifications[0].body}`;
    expect(text).toContain("FOLLOW-UP DUE");
    expect(text).not.toMatch(/\bsent\b/i);
    expect(text).not.toMatch(/\bdelivered\b/i);
  });

  it("never leaks the follow-up's subject or body", async () => {
    seedDueFollowUp();
    db.messages[0].subject = "Tajny predmet";
    db.messages[0].body = "Tajne telo";

    await processDueFollowUps({ notifier });
    const text = notifications[0].title + notifications[0].body + notifications[0].actionUrl;
    expect(text).not.toContain("Tajny predmet");
    expect(text).not.toContain("Tajne telo");
  });

  it("carries an opaque deep link and no message id in the payload", async () => {
    seedDueFollowUp();
    await processDueFollowUps({ notifier });

    const url = notifications[0].actionUrl;
    expect(url).toMatch(/^https:\/\/pepa\.example\.com\/followup\/fp1_/);
    expect(url).not.toContain(LEAD_ID);
    expect(url).not.toContain(FOLLOW_UP_ID);
    expect(url).not.toContain(OUTREACH_ID);
  });

  it("cannot be pointed at an arbitrary message: candidates come from the due view only", async () => {
    seedDueFollowUp();
    const orphan = seedFollowUpRow({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      sequence_number: 1,
      lead_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    });

    // There is no parameter for a message id: injecting one changes nothing,
    // because a row is only ever considered when the due view already selected
    // its lead, and the resolution is scoped to that lead.
    await processDueFollowUps({ notifier, ...({ messageId: orphan.id } as object) });

    expect(notifications).toHaveLength(1);
    expect(db.tokens[0].outreach_id).toBe(FOLLOW_UP_ID);
    expect(db.notifications[0].outreach_id).not.toBe(orphan.id);
  });
});

describe("Phase 8A — failure safety", () => {
  it("never records a failed Telegram delivery as delivered", async () => {
    seedDueFollowUp();
    failNextSend = true;

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.failed).toBe(1);
    expect(db.notifications).toHaveLength(0);
  });

  it("retries the same follow-up row after a delivery failure", async () => {
    seedDueFollowUp();
    failNextSend = true;
    await processDueFollowUps({ notifier });

    const retry = await processDueFollowUps({ notifier });
    expect(retry.notified).toBe(1);
    expect(db.notifications[0].followup_number).toBe(1);
    expect(db.notifications[0].outreach_id).toBe(FOLLOW_UP_ID);
  });

  it("releases the claim under the authoritative key, not the counter", async () => {
    seedDueFollowUp({ followup_count: 2, followup_number: 3 });
    failNextSend = true;

    await processDueFollowUps({ notifier });
    // The released row must be gone entirely, so the next run is not blocked by
    // a claim recorded under a number the follow-up does not own.
    expect(db.notifications).toHaveLength(0);
  });

  it("does not notify a follow-up that went out before the processor ran", async () => {
    seedDueFollowUp();
    // Operator sends it manually from the workspace, ahead of any cron run.
    db.messages[0].status = "sent";
    db.messages[0].sent_at = "2026-10-01T09:00:00.000Z";

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedAlreadySent).toBe(1);
    expect(notifications).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);
  });
});
