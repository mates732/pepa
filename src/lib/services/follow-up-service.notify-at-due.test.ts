import { beforeEach, describe, expect, it, vi } from "vitest";

import { markFollowUpSent } from "./follow-up-service";

/**
 * The notification timer — what the operator asked for.
 *
 * "When I mark the outreach as sent, set a timer for 4 days; when it expires,
 * the Telegram bot writes that the follow-up should go out, with a link to it."
 *
 * The cadence (`[4, 7, 10]` business days) is the timer and `next_followup_at`
 * is its expiry — both pre-existing. What is pinned here is the notification
 * anchor: `notification_due_at` is the DUE moment (optionally shifted by the
 * configured offset), never the send plus a delay. Anchoring on the send is
 * what made the bot write minutes after the email left the outbox instead of
 * when the follow-up came due.
 *
 * Delivery itself (the cron, the claim ledger, the deep link) is covered by
 * follow-up-service.test.ts and follow-up-service.telegram-3min.test.ts.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase, leadUpdates } = vi.hoisted(() => {
  const db = {
    leads: [] as Row[],
  };

  const leadUpdates: Row[] = [];

  function makeSupabase() {
    return {
      // `markFollowUpSent()` only reads and updates `leads`.
      from() {
        return {
          select: () => ({
            eq: (column: string, value: unknown) => ({
              maybeSingle: async () => ({
                data: db.leads.find((row) => row[column] === value) ?? null,
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
            b.then = async (onFulfilled: (value: unknown) => unknown) => {
              const matched = db.leads.filter((row) =>
                filters.every(([column, value]) => row[column] === value),
              );
              matched.forEach((row) => Object.assign(row, patch));
              leadUpdates.push(patch);
              return onFulfilled({ data: matched, error: null });
            };
            return b;
          },
        };
      },
    };
  }

  return { db, makeSupabase, leadUpdates };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

/** The configured offset, controllable per test. */
let delayConfig = { value: 0, unit: "minutes" as const };

vi.mock("@/lib/services/followup-notification-settings", () => ({
  getNotificationDelayConfig: async () => delayConfig,
  DEFAULT_DELAY: { value: 0, unit: "minutes" as const },
}));

const LEAD_ID = "11111111-1111-4111-8111-111111111111";

function seedLead(followupCount: number) {
  db.leads = [{ id: LEAD_ID, followup_count: followupCount }];
}

beforeEach(() => {
  db.leads = [];
  leadUpdates.length = 0;
  delayConfig = { value: 0, unit: "minutes" };
});

/** Monday 2026-10-05 08:00 UTC — a plain working week start in Prague too. */
const SENT_AT = new Date("2026-10-05T08:00:00.000Z");

describe("markFollowUpSent — the notification fires when the follow-up is due", () => {
  it("notifies at the cadence due moment (4 business days) with the default offset", async () => {
    seedLead(0);

    const result = await markFollowUpSent({ leadId: LEAD_ID, sentAt: SENT_AT });

    // Timestamped in the test: Monday + 4 business days = Friday, same time.
    expect(result.nextFollowUpAt).toBe("2026-10-09T08:00:00.000Z");
    expect(result.notificationDueAt).toBe(result.nextFollowUpAt);
    expect(leadUpdates).toHaveLength(1);
    expect(leadUpdates[0].notification_due_at).toBe(result.nextFollowUpAt);
  });

  it("does not anchor the notification on the send", async () => {
    seedLead(0);

    const result = await markFollowUpSent({ leadId: LEAD_ID, sentAt: SENT_AT });

    // The regression: notification_due_at used to be sentAt + 3 minutes, so the
    // bot wrote right after the email went out instead of 4 days later.
    expect(result.notificationDueAt).not.toBe("2026-10-05T08:03:00.000Z");
    expect(Date.parse(result.notificationDueAt!)).toBeGreaterThan(
      Date.parse(SENT_AT.toISOString()),
    );
  });

  it("shifts the notification by the configured offset, still measured from the due moment", async () => {
    seedLead(0);
    delayConfig = { value: 2, unit: "hours" };

    const result = await markFollowUpSent({ leadId: LEAD_ID, sentAt: SENT_AT });

    // Due Friday 08:00 → notification 2 hours later, not 2 hours after the send.
    expect(result.notificationDueAt).toBe("2026-10-09T10:00:00.000Z");
  });

  it("keeps the due moment the cadence computes for later follow-ups", async () => {
    seedLead(1);

    const result = await markFollowUpSent({ leadId: LEAD_ID, sentAt: SENT_AT });

    // Attempt #2 → cadence[1] = 7 business days after Monday 2026-10-05.
    expect(result.nextFollowUpAt).toBe("2026-10-14T08:00:00.000Z");
    expect(result.notificationDueAt).toBe(result.nextFollowUpAt);
  });

  it("schedules no notification once the cadence is exhausted", async () => {
    seedLead(3);

    const result = await markFollowUpSent({ leadId: LEAD_ID, sentAt: SENT_AT });

    // Nothing left to announce: no due moment, so no notification either.
    expect(result.nextFollowUpAt).toBeNull();
    expect(result.notificationDueAt).toBeNull();
    expect(leadUpdates[0].notification_due_at).toBeNull();
  });
});
