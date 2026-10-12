import { describe, expect, it } from "vitest";

import {
  followUpBucket,
  followUpScheduleState,
  groupFollowUps,
  scheduleStateLabel,
  type FollowUpBucketable,
} from "./follow-ups";

/**
 * The workspace's separation rule, pinned directly: the actionable queue holds
 * only what the server marked due; future follow-ups — and any follow-up whose
 * initial was never confirmed sent — never enter it.
 */

function row(overrides: Partial<FollowUpBucketable> = {}): FollowUpBucketable {
  return {
    due: false,
    dueAt: null,
    attention: 1,
    initialSent: true,
    message: { status: "draft", sent_at: null },
    ...overrides,
  };
}

describe("followUpBucket", () => {
  it("puts the server-marked due follow-up in the actionable queue", () => {
    expect(followUpBucket(row({ due: true, dueAt: "2026-10-01T08:00:00Z", attention: 0 }))).toBe("due");
  });

  it("keeps a future follow-up out of the actionable queue", () => {
    expect(followUpBucket(row({ dueAt: "2099-01-01T08:00:00Z", attention: 1 }))).toBe("scheduled");
  });

  it("never queues a follow-up whose initial was not sent", () => {
    // Inactive before the send is confirmed: no schedule, no queue, whatever
    // the row's age. This is the state an unsent initial leaves behind.
    expect(followUpBucket(row({ attention: 1, dueAt: null, initialSent: false }))).toBe("scheduled");
    expect(followUpBucket(row({ attention: 1, dueAt: null, initialSent: false }))).not.toBe("due");
  });

  it("routes a sent row to history even with a stale rank", () => {
    expect(followUpBucket(row({ message: { status: "sent", sent_at: "2026-09-30T09:00:00Z" } }))).toBe("sent");
    expect(
      followUpBucket(row({ attention: 0, due: true, message: { status: "sent", sent_at: "2026-09-30T09:00:00Z" } })),
    ).toBe("sent");
  });

  it("treats status=sent without a timestamp as sent too", () => {
    expect(followUpBucket(row({ message: { status: "sent", sent_at: null } }))).toBe("sent");
  });
});

describe("followUpScheduleState", () => {
  it("labels an arrived schedule as due", () => {
    expect(followUpScheduleState(row({ due: true, dueAt: "2026-10-01T08:00:00Z", attention: 0 }))).toBe("due");
  });

  it("labels a future schedule as scheduled", () => {
    expect(followUpScheduleState(row({ dueAt: "2099-01-01T08:00:00Z" }))).toBe("scheduled");
  });

  it("labels a sent initial without a clock as not scheduled", () => {
    expect(followUpScheduleState(row({ initialSent: true, dueAt: null }))).toBe("unscheduled");
  });

  it("labels an unsent initial as waiting — the inactive rule, visible", () => {
    expect(followUpScheduleState(row({ initialSent: false, dueAt: null }))).toBe("waiting-initial");
  });

  it("has a human label for every state", () => {
    (["due", "scheduled", "unscheduled", "waiting-initial"] as const).forEach((state) => {
      expect(scheduleStateLabel(state)).toBeTruthy();
    });
  });
});

describe("groupFollowUps", () => {
  it("partitions every item exactly once, preserving server order", () => {
    const due1 = row({ due: true, dueAt: "2026-10-01T08:00:00Z", attention: 0 });
    const due2 = row({ due: true, dueAt: "2026-10-02T08:00:00Z", attention: 0 });
    const later = row({ dueAt: "2099-01-01T08:00:00Z" });
    const sent = row({ attention: 2, message: { status: "sent", sent_at: "2026-09-30T09:00:00Z" } });

    const grouped = groupFollowUps([due1, due2, later, sent]);

    expect(grouped.due).toEqual([due1, due2]);
    expect(grouped.scheduled).toEqual([later]);
    expect(grouped.sent).toEqual([sent]);
    expect(grouped.due.length + grouped.scheduled.length + grouped.sent.length).toBe(4);
  });

  it("separates the due row from its own sequence's future rows", () => {
    // An initial's due follow-up and a later follow-up of the same sequence
    // must not sit side by side in one indistinguishable list.
    const due = row({ due: true, dueAt: "2026-10-01T08:00:00Z", attention: 0 });
    const future = row({ dueAt: "2099-01-01T08:00:00Z" });

    const grouped = groupFollowUps([due, future]);

    expect(grouped.due).toEqual([due]);
    expect(grouped.scheduled).toEqual([future]);
    expect(grouped.scheduled).not.toContain(due);
  });
});
