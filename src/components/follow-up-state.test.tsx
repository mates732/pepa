import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FollowUpState } from "@/components/follow-up-state";
import type { OutreachHistoryRow } from "@/lib/types";

/**
 * Follow-up state cell tests.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component tests, so
 * no new UI framework or DOM environment is introduced.
 *
 * The property pinned here is honesty. Since Phase 8A the notification ledger is
 * keyed by `outreach_messages.sequence_number`, while `next_followup_at` is still
 * written for `followup_count + 1`. On a lead with unrecorded history those are
 * different numbers, and this cell used to compare them — reporting "Telegram not
 * notified" for a follow-up the operator had just been notified about.
 */

/** A history row. Only the fields this cell reads matter. */
function row(overrides: Partial<OutreachHistoryRow> = {}): OutreachHistoryRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: "info@thearchive.cz",
    company_name: "The Archive",
    contact_name: null,
    status: "follow_up",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
    last_contacted_at: "2026-09-28T00:00:00.000Z",
    next_followup_at: "2026-10-08T08:00:00.000Z",
    followup_count: 0,
    latestSubject: "AI recepce",
    latestMessageStatus: "sent",
    latestMessageAt: "2026-09-28T00:00:00.000Z",
    messageCount: 1,
    lastFollowupNotifiedNumber: null,
    lastFollowupNotifiedAt: null,
    ...overrides,
  };
}

function render(overrides: Partial<OutreachHistoryRow> = {}): string {
  return renderToStaticMarkup(<FollowUpState row={row(overrides)} />);
}

describe("FollowUpState — schedule line", () => {
  it("names the follow-up the schedule is actually set to", () => {
    // next_followup_at was written for followup_count + 1, so this line is a true
    // statement about the schedule.
    expect(render({ followup_count: 2 })).toContain("Follow-up #3");
  });

  it("says so plainly when no follow-up is scheduled", () => {
    expect(render({ next_followup_at: null })).toContain("No follow-up scheduled");
  });

  it("stops at the cadence maximum", () => {
    const markup = render({ followup_count: 3 });
    expect(markup).toContain("Follow-up #3 done");
  });
});

describe("FollowUpState — notification line", () => {
  it("says not notified when the ledger has nothing", () => {
    expect(render()).toContain("Telegram not notified");
  });

  it("reports the notified follow-up number from the ledger, verbatim", () => {
    const markup = render({
      followup_count: 0,
      lastFollowupNotifiedNumber: 1,
      lastFollowupNotifiedAt: "2026-10-01T08:00:00.000Z",
    });

    expect(markup).toContain("Notified · #1");
  });

  it("reports a notification even when the ledger number is below the schedule number", () => {
    // The Phase 8A regression this component existed to avoid: unrecorded history
    // means the counter says #3 is due while the ledger records follow-up #1, and
    // both statements are true at once.
    const markup = render({
      followup_count: 2,
      next_followup_at: "2026-10-08T08:00:00.000Z",
      lastFollowupNotifiedNumber: 1,
      lastFollowupNotifiedAt: "2026-10-01T08:00:00.000Z",
    });

    expect(markup).toContain("Follow-up #3 · due");
    expect(markup).toContain("Notified · #1");
    expect(markup).not.toContain("Telegram not notified");
  });

  it("never claims a notification without a recorded time", () => {
    // A number with no timestamp is not a delivered notification; claiming one
    // would be inventing a fact.
    const markup = render({
      lastFollowupNotifiedNumber: 2,
      lastFollowupNotifiedAt: null,
    });

    expect(markup).toContain("Telegram not notified");
    expect(markup).not.toContain("Notified · #2");
  });

  it("never claims a notification without a number", () => {
    const markup = render({
      lastFollowupNotifiedNumber: null,
      lastFollowupNotifiedAt: "2026-10-01T08:00:00.000Z",
    });

    expect(markup).toContain("Telegram not notified");
  });
});
