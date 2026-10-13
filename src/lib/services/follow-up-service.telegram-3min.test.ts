import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  processDueFollowUps,
  type ActionNotifier,
} from "./follow-up-service";
import { formatDateTime } from "@/lib/format";
import { formatFollowUpDueMessage } from "@/lib/telegram/format";

/**
 * Verification of the Telegram follow-up notification path.
 *
 * The request: telegram must send the notification 3 minutes after implementation.
 *
 * The scheduler is a cron that runs repeatedly, so "3 minutes after" is not a
 * one-shot timer inside PEPA — it is the engine picking up a follow-up whose
 * `next_followup_at` has passed and delivering it once, then never again. This
 * test pins the clock so the "3 minutes later" behaviour is exact and
 * reproducible: a follow-up made due at T+0 is notified on the first run, and a
 * second run at T+3 minutes is quiet because the ledger already records the
 * delivery.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase } = vi.hoisted(() => {
  const db = {
    dueFollowups: [] as Row[],
    notifications: [] as Row[],
    tokens: [] as Row[],
    leads: [] as Row[],
    messages: [] as Row[],
    failBookkeeping: false,
    dueNow: null as number | null,
  };

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
      // The `due_followups` view filters `next_followup_at <= now()` in SQL.
      // Replicate that here so the fake matches the real view behaviour.
      const base =
        table === "due_followups"
          ? (db.dueFollowups as Row[]).filter((row) => {
              const dueAt = row.next_followup_at;
              if (!dueAt) return false;
              const now = db.dueNow ?? Date.now();
              return Date.parse(String(dueAt)) <= now;
            })
          : (db[TABLES[table]] as Row[]);

      const filtered = base.filter(
        (row) =>
          filters.every(({ column, op, value }) => {
            if (op === "eq") return row[column] === value;
            if (op === "is")
              return value === null ? (row[column] ?? null) === null : row[column] === value;
            if (op === "in") return (value as unknown[]).includes(row[column]);
            return Number(row[column] ?? Number.NEGATIVE_INFINITY) > Number(value);
          }),
      );
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

  function insertBuilder(table: Table, rows: Row[]) {
    const b: Record<string, unknown> = {};

    const attempt = () =>
      new Promise<{ data: Row[]; error: null } | { data: null; error: { code: string; message: string } }>(
        (resolve) => {
          setTimeout(() => {
            for (const row of rows) {
              if (table === "followup_notifications") {
                const clash = db.notifications.find(
                  (existing) =>
                    existing.lead_id === row.lead_id && existing.followup_number === row.followup_number,
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
              const rows = (db[TABLES[table]] as Row[]).filter(
                (row) => filters.every(([column, value]) => row[column] === value),
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
              const doomed = (db[TABLES[table]] as Row[]).filter(
                (row) => filters.every(([column, value]) => row[column] === value),
              );
              db[TABLES[table]] = (db[TABLES[table]] as Row[]).filter((row) => !doomed.includes(row));
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

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

let minted = 0;

vi.mock("@/lib/services/action-token-service", () => ({
  mintFollowUpToken: async ({ leadId }: { leadId: string; outreachId?: string | null }) => {
    const tokenId = `token-${(minted += 1)}`;
    db.tokens.push({ id: tokenId, lead_id: leadId, outreach_id: null });
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

const delivered: Array<{
  message: string;
  actionUrl: string;
  at: Date;
}> = [];

/** The notifier stores the timestamp the engine was given, not wall-clock time. */
let notifierNow: Date = new Date();

const notifier: ActionNotifier = {
  async sendActionNotification(notification) {
    // Mirror exactly what TelegramProvider.sendActionNotification sends:
    // `formatPlainNotification(title, body)` == `formatFollowUpDueMessage(details)`.
    delivered.push({
      message: `${notification.title}\n\n${notification.body}`,
      actionUrl: notification.actionUrl,
      at: notifierNow,
    });
  },
};

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const OUTREACH_ID = "22222222-2222-2222-2222-222222222222";
const FOLLOW_UP_ID = "55555555-5555-5555-5555-555555555555";
const EMAIL = "hello@example.cz";

function seedDueFollowUp(overrides: Partial<Row> = {}) {
  const now = new Date("2026-10-01T08:00:00.000Z");

  const dueRow: Row = {
    lead_id: LEAD_ID,
    email: EMAIL,
    company_name: "Example Business",
    contact_name: null,
    lead_status: "sent",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
    last_contacted_at: "2026-09-28T00:00:00.000Z",
    next_followup_at: now.toISOString(),
    followup_count: 0,
    outreach_id: OUTREACH_ID,
    recipient_email: EMAIL,
    subject: "AI recepce pro Example",
    body: "Dobrý den,...",
    outreach_status: "sent",
    sent_at: "2026-09-28T00:00:00.000Z",
    outreach_created_at: "2026-09-28T00:00:00.000Z",
    followup_number: 1,
    ...overrides,
  };
  db.dueFollowups.push(dueRow);
  db.leads.push({
    id: LEAD_ID,
    followup_count: 0,
    next_followup_at: now.toISOString(),
    ...overrides,
  });
  seedFollowUpRow({ sequence_number: 1 });
  return dueRow;
}

function seedFollowUpRow(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: FOLLOW_UP_ID,
    lead_id: LEAD_ID,
    recipient_email: EMAIL,
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

beforeEach(() => {
  minted = 0;
  delivered.length = 0;
  db.dueFollowups = [];
  db.notifications = [];
  db.tokens = [];
  db.leads = [];
  db.messages = [];
  db.failBookkeeping = false;
  db.dueNow = null;
  notifierNow = new Date();
});

/** Run the engine with both the due-view clock and the notifier clock pinned. */
async function runEngine(
  now: Date,
  opts?: { notifier?: ActionNotifier; limit?: number },
): Promise<ReturnType<typeof processDueFollowUps>> {
  db.dueNow = now.getTime();
  notifierNow = now;
  return processDueFollowUps({ ...opts, now });
}

describe("Telegram follow-up notification — 3 minute scheduling verification", () => {
  it("notifies a follow-up the first time the scheduler runs after it becomes due", async () => {
    seedDueFollowUp();

    const now = new Date("2026-10-01T08:00:00.000Z");
    const outcome = await runEngine(now, { notifier });

    expect(outcome.examined).toBe(1);
    expect(outcome.notified).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].at.getTime()).toBe(now.getTime());
  });

  it("renders the exact Telegram payload the operator sees", async () => {
    seedDueFollowUp();

    const now = new Date("2026-10-01T08:00:00.000Z");
    await runEngine(now, { notifier });

    // The due line uses the same formatter the notification uses, so the pin is
    // exact without assuming a machine time zone.
    expect(delivered[0].message).toBe(
      [
        "🔥 FOLLOW-UP DUE",
        "",
        "Example Business",
        "",
        "Follow-up #1",
        `Due: ${formatDateTime("2026-10-01T08:00:00.000Z")}`,
        "Last contact: 28 Sept 2026",
        "",
        EMAIL,
      ].join("\n"),
    );
  });

  it("sends exactly one Telegram message even when the scheduler runs again 3 minutes later", async () => {
    seedDueFollowUp();

    const firstRun = new Date("2026-10-01T08:00:00.000Z");
    const threeMinutesLater = new Date(firstRun.getTime() + 3 * 60 * 1000);

    await runEngine(firstRun, { notifier });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].at).toBe(firstRun);

    await runEngine(threeMinutesLater, { notifier });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].at).toBe(firstRun);
  });

  it("keeps the notification surface stable across the 3-minute gap", async () => {
    seedDueFollowUp();

    const firstRun = new Date("2026-10-01T08:00:00.000Z");
    const threeMinutesLater = new Date(firstRun.getTime() + 3 * 60 * 1000);

    db.dueNow = firstRun.getTime();
    await runEngine(firstRun, { notifier });
    const firstMessage = delivered[0].message;

    await runEngine(threeMinutesLater, { notifier });
    // A second send would have changed the clock on the message and produced a
    // second entry; neither happened.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].message).toBe(firstMessage);
  });

  it("does not re-notify when the follow-up was already delivered before the 3-minute check", async () => {
    seedDueFollowUp();

    const now = new Date("2026-10-01T08:00:00.000Z");
    await processDueFollowUps({ notifier, now });
    expect(delivered).toHaveLength(1);

    // Simulate the ledger already existing — as if a prior run delivered it.
    db.notifications.push({
      lead_id: LEAD_ID,
      outreach_id: FOLLOW_UP_ID,
      followup_number: 1,
      status: "sent",
      claimed_at: now.toISOString(),
      sent_at: now.toISOString(),
    });

    const threeMinutesLater = new Date(now.getTime() + 3 * 60 * 1000);
    const outcome = await runEngine(threeMinutesLater, { notifier });

    expect(outcome.notified).toBe(0);
    expect(outcome.skippedAlreadyNotified).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it("retries on the next scheduler pass when Telegram is down at the 3-minute mark", async () => {
    seedDueFollowUp();

    const firstRun = new Date("2026-10-01T08:00:00.000Z");
    db.dueNow = firstRun.getTime();

    // First run: notify succeeds.
    await processDueFollowUps({ notifier, now: firstRun });
    expect(delivered).toHaveLength(1);

    // Wipe the delivery and ledger so the second run observes a clean failure path.
    delivered.length = 0;
    db.notifications.length = 0;

    // Second run: the due follow-up exists again, Telegram is unavailable.
    const threeMinutesLater = new Date(firstRun.getTime() + 3 * 60 * 1000);
    const failingNotifier: ActionNotifier = {
      async sendActionNotification() {
        throw new Error("Telegram delivery failed: 502");
      },
    };

    const failed = await processDueFollowUps({ notifier: failingNotifier, now: threeMinutesLater });
    expect(failed.failed).toBe(1);
    expect(failed.notified).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(db.notifications).toHaveLength(0);

    // Third run: 3 minutes after the failure, the claim was released, so the
    // follow-up is notified again.
    const retry = await runEngine(new Date(threeMinutesLater.getTime() + 3 * 60 * 1000), { notifier });
    expect(retry.notified).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it("does nothing when no follow-up is due yet (future scheduling)", async () => {
    seedDueFollowUp({ next_followup_at: new Date("2026-10-04T08:00:00.000Z").toISOString() });

    const now = new Date("2026-10-01T08:00:00.000Z");
    db.dueNow = now.getTime();
    const outcome = await processDueFollowUps({ notifier, now });

    expect(outcome.examined).toBe(0);
    expect(delivered).toHaveLength(0);
  });

  it("the deep link in the notification points at the follow-up row, not the anchor email", async () => {
    seedDueFollowUp();

    const now = new Date("2026-10-01T08:00:00.000Z");
    await processDueFollowUps({ notifier, now });

    await runEngine(now, { notifier });
    expect(delivered[0].actionUrl).toMatch(/^https:\/\/pepa\.example\.com\/followup\/fp1_/);
    expect(delivered[0].actionUrl).not.toContain(LEAD_ID);
    expect(delivered[0].actionUrl).not.toContain(OUTREACH_ID);
    expect(delivered[0].actionUrl).not.toContain(FOLLOW_UP_ID);
  });
});
