import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStreakReminderState,
  processStreakReminder,
} from "./streak-reminder-service";

/**
 * The 19:00 streak reminder engine.
 *
 * The operator's requirement: a day with no recorded send, by 19:00 local,
 * yields exactly one Telegram message naming the streak at risk. These tests
 * pin the whole path — state, claim, delivery, ledger — against the same fake
 * store the follow-up engine tests use, with the clock pinned to a real
 * Wednesday evening in Prague.
 *
 * Delivery format is covered by the formatter tests; what matters here is
 * WHEN and HOW OFTEN, not the wording.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase, notifier } = vi.hoisted(() => {
  const db = {
    messages: [] as Row[],
    reminders: [] as Row[],
    failMessages: false,
  };

  function makeSupabase() {
    return {
      from(table: "outreach_messages" | "streak_reminders") {
        if (table === "outreach_messages") {
          return {
            select: () => ({
              eq: () => ({
                not: () => ({
                  order: () => ({
                    limit: () => ({
                      then: (onFulfilled: (value: unknown) => unknown) =>
                        Promise.resolve(
                          db.failMessages
                            ? { data: null, error: { message: "outreach_messages unavailable" } }
                            : { data: [...db.messages].reverse(), error: null },
                        ).then(onFulfilled),
                    }),
                  }),
                }),
              }),
            }),
          };
        }

        // streak_reminders
        const matched = (filters: Array<[string, unknown]>) =>
          db.reminders.filter((row) => filters.every(([column, value]) => row[column] === value));

        return {
          insert(row: Row) {
            return {
              then: (onFulfilled: (value: unknown) => unknown) => {
                const clash = db.reminders.find((existing) => existing.day_key === row.day_key);
                if (clash) {
                  return Promise.resolve({
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  }).then(onFulfilled);
                }
                db.reminders.push({ ...row });
                return Promise.resolve({ data: [row], error: null }).then(onFulfilled);
              },
            };
          },
          select: () => ({
            eq: (column: string, value: unknown) => ({
              maybeSingle: async () => ({
                data: matched([[column, value]])[0] ?? null,
                error: null,
              }),
            }),
          }),
          update(patch: Row) {
            const filters: Array<[string, unknown]> = [];
            const b: Record<string, unknown> = {};
            b.eq = (column: string, value: unknown) => {
              filters.push([column, value]);
              return b;
            };
            b.select = () => b;
            b.maybeSingle = async () => {
              // The real driver applies the patch and returns the row.
              const rows = matched(filters);
              rows.forEach((row) => Object.assign(row, patch));
              return { data: rows[0] ?? null, error: null };
            };
            b.then = async (onFulfilled: (value: unknown) => unknown) => {
              matched(filters).forEach((row) => Object.assign(row, patch));
              return onFulfilled({ data: [], error: null });
            };
            return b;
          },
          delete() {
            const filters: Array<[string, unknown]> = [];
            const b: Record<string, unknown> = {};
            b.eq = (column: string, value: unknown) => {
              filters.push([column, value]);
              return b;
            };
            b.then = async (onFulfilled: (value: unknown) => unknown) => {
              const doomed = matched(filters);
              db.reminders = db.reminders.filter((row) => !doomed.includes(row));
              return onFulfilled({ data: doomed, error: null });
            };
            return b;
          },
        };
      },
    };
  }

  const notifier = {
    enabled: true,
    deliveries: [] as Array<{ title: string; body: string; actionUrl: string }>,
    failNext: false,
    async sendActionNotification(notification: { title: string; body: string; actionUrl: string }) {
      if (notifier.failNext) {
        notifier.failNext = false;
        throw new Error("Telegram delivery failed: 502");
      }
      notifier.deliveries.push(notification);
    },
  };

  return { db, makeSupabase, notifier };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

vi.mock("@/lib/providers/notifications", () => ({
  getNotificationChannel: () => (notifier.enabled ? notifier : null),
}));

vi.mock("@/lib/config/base-url", () => ({
  getBaseUrl: async () => "https://pepa.example.com",
}));

/** Wednesday 2026-10-14, 19:00 in Prague (17:00 UTC, CEST). */
const REMINDER_TIME = new Date("2026-10-14T17:00:00.000Z");

/** Sends on Tuesday and Monday Prague time. */
function seedSends() {
  db.messages = [
    { status: "sent", sent_at: "2026-10-13T09:00:00.000Z" },
    { status: "sent", sent_at: "2026-10-12T09:00:00.000Z" },
  ];
}

function reminderRow(overrides: Partial<Row> = {}): Row {
  return {
    day_key: "2026-10-14",
    status: "claimed",
    streak_days: 2,
    claimed_at: REMINDER_TIME.toISOString(),
    sent_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  db.messages = [];
  db.reminders = [];
  db.failMessages = false;
  notifier.deliveries.length = 0;
  notifier.enabled = true;
  notifier.failNext = false;
});

describe("getStreakReminderState", () => {
  it("resolves the day keys, the hour and the streak at risk", async () => {
    seedSends();

    const result = await getStreakReminderState({ now: REMINDER_TIME });

    expect(result.ok).toBe(true);
    const state = result.data!;
    expect(state.todayKey).toBe("2026-10-14");
    expect(state.hour).toBe(19);
    expect(state.sentToday).toBe(0);
    expect(state.atRisk).toBe(true);
    expect(state.due).toBe(true);
    expect(state.streakDays).toBe(2);
    expect(state.timeZone).toBe("Europe/Prague");
    expect(state.complete).toBe(true);
  });

  it("counts today's sends and reports the streak as safe", async () => {
    seedSends();
    db.messages.push({ status: "sent", sent_at: "2026-10-14T10:00:00.000Z" });

    const state = (await getStreakReminderState({ now: REMINDER_TIME })).data!;

    expect(state.sentToday).toBe(1);
    expect(state.atRisk).toBe(false);
    expect(state.due).toBe(false);
    expect(state.streakDays).toBe(0);
  });

  it("ignores rows that are not confirmed sends", async () => {
    seedSends();
    db.messages.push(
      { status: "draft", sent_at: null },
      { status: "sent", sent_at: null },
      { status: "ready", sent_at: "2026-10-14T08:00:00.000Z" },
    );

    const state = (await getStreakReminderState({ now: REMINDER_TIME })).data!;

    expect(state.sentToday).toBe(0);
    expect(state.atRisk).toBe(true);
  });

  it("resolves the calendar in the zone it is given, not the server's", async () => {
    seedSends();
    // 16:59 UTC is 18:59 Prague — one minute before the deadline.
    const beforeDeadline = new Date("2026-10-14T16:59:00.000Z");
    const state = await getStreakReminderState({ now: beforeDeadline });

    expect(state.ok).toBe(true);
    expect(state.data!.hour).toBe(18);
    expect(state.data!.due).toBe(false);
    expect(state.data!.atRisk).toBe(true);
  });

  it("reports a failed load as a failure, not as nothing-to-do", async () => {
    db.failMessages = true;

    const result = await getStreakReminderState({ now: REMINDER_TIME });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("processStreakReminder — when it writes", () => {
  it("delivers exactly one message at 19:00 when a streak is at risk", async () => {
    seedSends();

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome).toMatchObject({
      checked: true,
      reminded: true,
      skippedNothingAtRisk: false,
      skippedNotDue: false,
      skippedAlreadyReminded: false,
      failed: false,
    });
    expect(notifier.deliveries).toHaveLength(1);

    const [delivery] = notifier.deliveries;
    expect(delivery.title).toContain("STREAK REMINDER");
    expect(delivery.body).toContain("2-day streak");
    expect(delivery.body).toContain("No outreach recorded as sent today.");
    expect(delivery.actionUrl).toBe("https://pepa.example.com/");

    // The delivery is recorded for the calendar day, with the streak it named.
    expect(db.reminders).toHaveLength(1);
    expect(db.reminders[0]).toMatchObject({
      day_key: "2026-10-14",
      status: "sent",
      streak_days: 2,
    });
  });

  it("stays silent before the deadline even with a streak at risk", async () => {
    seedSends();

    const outcome = await processStreakReminder({ now: new Date("2026-10-14T16:00:00.000Z") });

    expect(outcome.skippedNotDue).toBe(true);
    expect(outcome.reminded).toBe(false);
    expect(notifier.deliveries).toHaveLength(0);
    expect(db.reminders).toHaveLength(0);
  });

  it("stays silent when today already has a send", async () => {
    seedSends();
    db.messages.push({ status: "sent", sent_at: "2026-10-14T10:00:00.000Z" });

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome.skippedNothingAtRisk).toBe(true);
    expect(notifier.deliveries).toHaveLength(0);
    expect(db.reminders).toHaveLength(0);
  });

  it("stays silent when yesterday had no send — nothing is at risk", async () => {
    db.messages = [{ status: "sent", sent_at: "2026-10-11T09:00:00.000Z" }];

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome.skippedNothingAtRisk).toBe(true);
    expect(notifier.deliveries).toHaveLength(0);
    expect(db.reminders).toHaveLength(0);
  });
});

describe("processStreakReminder — once per day", () => {
  it("does not write again when the scheduler runs again the same evening", async () => {
    seedSends();

    await processStreakReminder({ now: REMINDER_TIME });
    const later = new Date("2026-10-14T18:30:00.000Z");
    const outcome = await processStreakReminder({ now: later });

    expect(outcome.skippedAlreadyReminded).toBe(true);
    expect(outcome.reminded).toBe(false);
    expect(notifier.deliveries).toHaveLength(1);
  });

  it("a later run still writes on a NEW day", async () => {
    seedSends();
    await processStreakReminder({ now: REMINDER_TIME });

    // Thursday evening, still nothing sent today (Wed/Fri had none).
    db.messages = [
      { status: "sent", sent_at: "2026-10-14T09:00:00.000Z" },
      { status: "sent", sent_at: "2026-10-13T09:00:00.000Z" },
    ];
    const thursday = new Date("2026-10-15T17:00:00.000Z");
    const outcome = await processStreakReminder({ now: thursday });

    expect(outcome.reminded).toBe(true);
    expect(notifier.deliveries).toHaveLength(2);
    expect(db.reminders.map((row) => row.day_key)).toEqual(["2026-10-14", "2026-10-15"]);
  });
});

describe("processStreakReminder — delivery failure", () => {
  it("releases the claim so a later run retries, and records nothing", async () => {
    seedSends();
    notifier.failNext = true;

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome.failed).toBe(true);
    expect(outcome.reminded).toBe(false);
    expect(db.reminders).toHaveLength(0);

    // The retry succeeds and writes exactly once.
    const retry = await processStreakReminder({ now: new Date("2026-10-14T18:00:00.000Z") });
    expect(retry.reminded).toBe(true);
    expect(notifier.deliveries).toHaveLength(1);
  });

  it("fails without a configured channel and leaves no claim behind", async () => {
    seedSends();
    notifier.enabled = false;

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome.failed).toBe(true);
    expect(notifier.deliveries).toHaveLength(0);
    expect(db.reminders).toHaveLength(0);
  });

  it("fails when the state cannot be resolved", async () => {
    seedSends();
    db.failMessages = true;

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome).toMatchObject({ checked: false, reminded: false, failed: true });
    expect(notifier.deliveries).toHaveLength(0);
  });
});

describe("processStreakReminder — an expired claim is retaken", () => {
  it("takes over a claim whose lease expired long ago", async () => {
    seedSends();
    // A crashed run hours ago: claimed, never sent, lease long expired.
    db.reminders.push(
      reminderRow({ claimed_at: new Date("2026-10-14T10:00:00.000Z").toISOString() }),
    );

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome.reminded).toBe(true);
    expect(notifier.deliveries).toHaveLength(1);
    expect(db.reminders[0].status).toBe("sent");
  });

  it("leaves a fresh claim alone", async () => {
    seedSends();
    // A run seconds ago that is still delivering.
    db.reminders.push(
      reminderRow({ claimed_at: new Date("2026-10-14T16:59:30.000Z").toISOString() }),
    );

    const outcome = await processStreakReminder({ now: REMINDER_TIME });

    expect(outcome.skippedAlreadyReminded).toBe(true);
    expect(outcome.reminded).toBe(false);
    expect(notifier.deliveries).toHaveLength(0);
  });
});
