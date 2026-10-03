import { describe, expect, it } from "vitest";

import { groupActivityByDay, localDayKey } from "@/lib/outreach/activity-days";

/**
 * Tests for Activity day grouping.
 *
 * The grouping is pure, so it is tested without a store or a clock of its own:
 * `now` is passed in. Timestamps are absolute UTC instants, exactly as
 * `followup/cadence.ts` stores them, and grouping happens in the local calendar
 * day — the same zone the rest of PEPA renders in.
 */

interface Row {
  id: string;
  sentAt: string | null;
}

function row(id: string, sentAt: string | null): Row {
  return { id, sentAt };
}

function sentAtOf(item: Row): string | null {
  return item.sentAt;
}

/** 2026-10-03 is a Saturday; the fixed "now" keeps relative labels stable. */
const NOW = new Date(2026, 9, 3, 12, 0, 0);

function localIso(day: number, hour: number, minute = 0): string {
  // Built from local parts on purpose: the assertions are about local days.
  return new Date(2026, 9, day, hour, minute, 0).toISOString();
}

describe("localDayKey", () => {
  it("uses the local calendar day, not the UTC one", () => {
    // 23:30 local on the 3rd is the next day in UTC for any positive offset, so
    // a UTC-based key would report the wrong section.
    expect(localDayKey(localIso(3, 23, 30))).toBe("2026-10-03");
    expect(localDayKey(localIso(4, 0, 15))).toBe("2026-10-04");
  });

  it("reports an unusable value as undated rather than guessing", () => {
    expect(localDayKey("not-a-date")).toBe("undated");
  });
});

describe("groupActivityByDay", () => {
  it("splits rows into local days, newest first", () => {
    const groups = groupActivityByDay(
      [
        row("older", localIso(2, 8, 52)),
        row("newest", localIso(3, 14, 8)),
        row("mid-morning", localIso(3, 9, 14)),
      ],
      sentAtOf,
      NOW,
    );

    expect(groups.map((g) => g.key)).toEqual(["2026-10-03", "2026-10-02"]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["newest", "mid-morning"]);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["older"]);
  });

  it("labels today and yesterday, and dates everything else", () => {
    const groups = groupActivityByDay(
      [row("today", localIso(3, 9, 14)), row("yesterday", localIso(2, 23, 0)), row("older", localIso(1, 12, 0))],
      sentAtOf,
      NOW,
    );

    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", formatExpected(1)]);
    expect(groups[2]?.key).toBe("2026-10-01");
  });

  it("keeps the caller's order within a day", () => {
    // The service already ordered these newest-first; grouping must not re-sort
    // rows it does not own.
    const groups = groupActivityByDay(
      [row("c", localIso(3, 8, 0)), row("b", localIso(3, 9, 0)), row("a", localIso(3, 10, 0))],
      sentAtOf,
      NOW,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupActivityByDay([], sentAtOf, NOW)).toEqual([]);
  });

  it("keeps an undated send visible instead of dropping or mis-dating it", () => {
    const groups = groupActivityByDay(
      [row("undated", null), row("broken", "not-a-date"), row("today", localIso(3, 10, 0))],
      sentAtOf,
      NOW,
    );

    expect(groups.map((g) => g.key)).toEqual(["2026-10-03", "undated"]);
    expect(groups[1]?.label).toBe("Date not recorded");
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["undated", "broken"]);
  });

  it("sorts by the day key, not by creation order", () => {
    const groups = groupActivityByDay(
      [row("a", localIso(1, 12, 0)), row("b", localIso(3, 12, 0)), row("c", localIso(2, 12, 0))],
      sentAtOf,
      NOW,
    );

    expect(groups.map((g) => g.key)).toEqual(["2026-10-03", "2026-10-02", "2026-10-01"]);
  });

  it("rolls the day boundary at local midnight", () => {
    const late = new Date(2026, 9, 3, 23, 59, 0).toISOString();
    const early = new Date(2026, 9, 4, 0, 1, 0).toISOString();

    // One minute before midnight: the 3rd is "Today" and the 4th is dated.
    const before = groupActivityByDay([row("late", late), row("early", early)], sentAtOf, new Date(2026, 9, 3, 23, 59, 59));
    expect(before.map((g) => g.key)).toEqual(["2026-10-04", "2026-10-03"]);
    expect(before[0]?.label).toBe(formatExpected(4));
    expect(before[1]?.label).toBe("Today");

    // One minute after: the same two sends swap relative labels, which is what
    // a local-calendar grouping is supposed to do.
    const after = groupActivityByDay([row("late", late), row("early", early)], sentAtOf, new Date(2026, 9, 4, 0, 1, 0));
    expect(after.map((g) => g.key)).toEqual(["2026-10-04", "2026-10-03"]);
    expect(after[0]?.label).toBe("Today");
    expect(after[1]?.label).toBe("Yesterday");
  });
});

/**
 * The label format for a non-recent day is whatever `lib/format.ts` produces for
 * that day, so the expectation is derived from the same helper rather than
 * hard-coded: a locale change must not make this test lie about the behaviour.
 */
function formatExpected(day: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(2026, 9, day));
}