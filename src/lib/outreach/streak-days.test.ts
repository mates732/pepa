import { describe, expect, it } from "vitest";

import {
  computeStreakMetrics,
  currentStreakFrom,
  daysBetweenKeys,
  longestStreakFrom,
  shiftDayKey,
} from "@/lib/outreach/streak-days";
import { localDayKeyInZone, resolveStatsWindows } from "@/lib/outreach/stats-windows";

/**
 * Tests for the streak arithmetic.
 *
 * Two layers are covered deliberately:
 *
 *   * the pure arithmetic over calendar-day keys, where every date is written
 *     out and nothing depends on a clock;
 *   * the keys themselves, derived through `localDayKeyInZone` from real UTC
 *     instants, which is where daylight saving, 23- and 25-hour days and
 *     non-whole-hour zones actually live.
 *
 * There is no `Date.now()` and no fake clock in this file because there is no
 * clock to control: `todayKey` is an argument. Tests that do need a wall clock
 * pin it through `resolveStatsWindows(timeZone, now)` in the service tests.
 */

const PRAGUE = "Europe/Prague";
const NEW_YORK = "America/New_York";
const KATHMANDU = "Asia/Kathmandu";
const LORD_HOWE = "Australia/Lord_Howe";
const SANTIAGO = "America/Santiago";

/** October 2026 as seen from Prague. Week is Mon 5th – Sun 11th. */
const NOW = new Date("2026-10-07T10:00:00.000Z");

const EMPTY_RANGES = {
  weekStartKey: "2026-10-05",
  weekEndKey: "2026-10-12",
  monthStartKey: "2026-10-01",
  monthEndKey: "2026-11-01",
};

/** Measure a set of day keys against the pinned October ranges. */
function metrics(dayKeys: string[], todayKey = "2026-10-07") {
  return computeStreakMetrics({ dayKeys, todayKey, ...EMPTY_RANGES });
}

/** Turn UTC instants into the keys the service would derive for Prague. */
function keysOf(instants: string[], timeZone: string = PRAGUE): string[] {
  return instants.map((instant) => localDayKeyInZone(timeZone, instant) as string);
}

describe("shiftDayKey — calendar arithmetic on a date", () => {
  it("moves a day forward and back across a month boundary", () => {
    expect(shiftDayKey("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDayKey("2026-10-01", -1)).toBe("2026-09-30");
  });

  it("moves across a leap day", () => {
    expect(shiftDayKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDayKey("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("moves across a year boundary", () => {
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDayKey("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("counts whole days, never 24-hour chunks", () => {
    // Twenty-four calendar days forward, whatever the zone did in between: the
    // key carries no time, so no offset can shorten or lengthen it.
    expect(shiftDayKey("2026-03-01", 24)).toBe("2026-03-25");
  });
});

describe("active days — several sends on one day are one day", () => {
  it("reports no active day for an empty history", () => {
    expect(metrics([])).toEqual({
      currentStreak: 0,
      longestStreak: 0,
      activeDaysThisWeek: 0,
      activeDaysThisMonth: 0,
      totalActiveDays: 0,
      daysInWeek: 7,
      daysInMonth: 31,
    });
  });

  it("collapses duplicate keys", () => {
    const result = metrics(["2026-10-07", "2026-10-07", "2026-10-07", "2026-10-07"]);

    expect(result.totalActiveDays).toBe(1);
    expect(result.currentStreak).toBe(1);
    expect(result.activeDaysThisWeek).toBe(1);
  });

  it("drops a malformed key instead of shifting it into a neighbouring day", () => {
    const result = computeStreakMetrics({
      dayKeys: ["2026-10-07", "20-10-07", "2026-1-7", ""],
      todayKey: "2026-10-07",
      ...EMPTY_RANGES,
    });

    expect(result.totalActiveDays).toBe(1);
  });

  it("derives one key per day from nine sends spread across one day", () => {
    // 09:00, 10:00, 14:00 and 23:00 local are still one calendar day.
    const result = metrics(
      keysOf([
        "2026-10-07T07:00:00.000Z",
        "2026-10-07T08:00:00.000Z",
        "2026-10-07T12:00:00.000Z",
        "2026-10-07T21:00:00.000Z",
      ]),
    );

    expect(result.totalActiveDays).toBe(1);
    expect(result.activeDaysThisWeek).toBe(1);
  });
});

describe("current streak — a run of days ending today", () => {
  it("is 1 for today alone", () => {
    expect(metrics(["2026-10-07"]).currentStreak).toBe(1);
  });

  it("is 2 for today and yesterday", () => {
    expect(metrics(["2026-10-07", "2026-10-06"]).currentStreak).toBe(2);
  });

  it("is 3 across three consecutive days", () => {
    expect(metrics(["2026-10-07", "2026-10-06", "2026-10-05"]).currentStreak).toBe(3);
  });

  it("stops at a gap", () => {
    // Today, yesterday and the day before yesterday; the 4th is missing.
    expect(metrics(["2026-10-07", "2026-10-06", "2026-10-04"]).currentStreak).toBe(2);
  });

  it("is 0 when today has no send", () => {
    expect(metrics(["2026-10-06", "2026-10-05"]).currentStreak).toBe(0);
  });

  it("does not count a streak that ended yesterday as current", () => {
    // Yesterday through Sunday is a four-day run, and it is over. Reporting 4
    // here would claim an unbroken streak that today has already broken.
    expect(metrics(["2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03"]).currentStreak).toBe(0);
    // It is still reported as history.
    expect(metrics(["2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03"]).longestStreak).toBe(4);
  });

  it("is not inflated by several sends today", () => {
    expect(metrics(["2026-10-07", "2026-10-07", "2026-10-07", "2026-10-06"]).currentStreak).toBe(2);
  });

  it("is 0 when there is no history at all", () => {
    expect(currentStreakFrom(new Set(), "2026-10-07")).toBe(0);
  });

  it("is 0 when today cannot be identified", () => {
    expect(currentStreakFrom(new Set(["2026-10-07"]), "")).toBe(0);
  });
});

describe("longest streak — the longest run anywhere in the history", () => {
  it("is 1 for a single active day", () => {
    expect(metrics(["2026-10-01"]).longestStreak).toBe(1);
  });

  it("is the length of a consecutive run", () => {
    expect(metrics(["2026-10-01", "2026-10-02", "2026-10-03"]).longestStreak).toBe(3);
  });

  it("picks the longest of several runs", () => {
    // Mon–Tue, Wed inactive, Thu–Fri–Sat, Sun inactive → 3.
    const result = metrics([
      "2026-09-28",
      "2026-09-29",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-05",
    ]);

    expect(result.longestStreak).toBe(3);
  });

  it("keeps an earlier longer run when a later shorter one arrives", () => {
    const result = metrics(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06"]);

    expect(result.longestStreak).toBe(3);
  });

  it("is not inflated by duplicate sends on one day", () => {
    const result = metrics(["2026-10-01", "2026-10-01", "2026-10-01", "2026-10-02", "2026-10-02"]);

    expect(result.longestStreak).toBe(2);
    expect(result.totalActiveDays).toBe(2);
  });

  it("breaks a run on a single inactive day", () => {
    // Two days, one missing, two days: 2 and 2, not 4.
    expect(metrics(["2026-10-01", "2026-10-03", "2026-10-04"]).longestStreak).toBe(2);
  });

  it("is independent of the order the keys arrive in", () => {
    const forwards = longestStreakFrom(new Set(["2026-10-01", "2026-10-02", "2026-10-04"]));
    const backwards = longestStreakFrom(new Set(["2026-10-04", "2026-10-02", "2026-10-01"]));

    expect(forwards).toBe(backwards);
    expect(forwards).toBe(2);
  });

  it("counts one whole month of consecutive days correctly", () => {
    const month: string[] = [];
    for (let day = 1; day <= 31; day += 1) {
      month.push(`2026-10-${String(day).padStart(2, "0")}`);
    }

    expect(longestStreakFrom(new Set(month))).toBe(31);
  });

  it("crosses a month boundary as one run", () => {
    expect(metrics(["2026-10-30", "2026-10-31", "2026-11-01"]).longestStreak).toBe(3);
  });
});

describe("week and month ranges", () => {
  it("counts each day of the current week once", () => {
    const result = metrics([
      "2026-10-05",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-11",
    ]);

    expect(result.activeDaysThisWeek).toBe(4);
  });

  it("excludes the last day of the previous week", () => {
    // Sunday 2026-10-04 belongs to the week that began on the 28th.
    const result = metrics(["2026-10-04"]);
    expect(result.activeDaysThisWeek).toBe(0);
    expect(result.activeDaysThisMonth).toBe(1);
  });

  it("excludes the first day of the next week", () => {
    expect(metrics(["2026-10-12"]).activeDaysThisWeek).toBe(0);
  });

  it("includes Monday, the first day of the week", () => {
    expect(metrics(["2026-10-05"]).activeDaysThisWeek).toBe(1);
  });

  it("includes Sunday, the last day of the week", () => {
    expect(metrics(["2026-10-11"]).activeDaysThisWeek).toBe(1);
  });

  it("excludes the last day of the previous month", () => {
    expect(metrics(["2026-09-30"]).activeDaysThisMonth).toBe(0);
    expect(metrics(["2026-09-30"]).totalActiveDays).toBe(1);
  });

  it("excludes the first day of the next month", () => {
    expect(metrics(["2026-11-01"]).activeDaysThisMonth).toBe(0);
  });

  it("reports the real length of the month as its denominator", () => {
    expect(metrics([]).daysInMonth).toBe(31);
    expect(
      computeStreakMetrics({
        dayKeys: [],
        todayKey: "2026-02-10",
        weekStartKey: "2026-02-09",
        weekEndKey: "2026-02-16",
        monthStartKey: "2026-02-01",
        monthEndKey: "2026-03-01",
      }).daysInMonth,
    ).toBe(28);
    expect(
      computeStreakMetrics({
        dayKeys: [],
        todayKey: "2028-02-10",
        weekStartKey: "2028-02-07",
        weekEndKey: "2028-02-14",
        monthStartKey: "2028-02-01",
        monthEndKey: "2028-03-01",
      }).daysInMonth,
    ).toBe(29);
    expect(
      computeStreakMetrics({
        dayKeys: [],
        todayKey: "2026-04-10",
        weekStartKey: "2026-04-06",
        weekEndKey: "2026-04-13",
        monthStartKey: "2026-04-01",
        monthEndKey: "2026-05-01",
      }).daysInMonth,
    ).toBe(30);
  });

  it("reports the week denominator as seven days", () => {
    expect(metrics([]).daysInWeek).toBe(7);
  });
});

describe("daysBetweenKeys", () => {
  it("counts whole days in a half-open range", () => {
    expect(daysBetweenKeys("2026-10-01", "2026-11-01")).toBe(31);
    expect(daysBetweenKeys("2026-10-05", "2026-10-12")).toBe(7);
  });

  it("returns 0 rather than a nonsense denominator", () => {
    expect(daysBetweenKeys("2026-11-01", "2026-10-01")).toBe(0);
    expect(daysBetweenKeys("", "2026-10-01")).toBe(0);
  });
});

describe("daylight saving — a calendar day is not 24 hours", () => {
  it("files a send by its local date, not by its UTC date", () => {
    // 22:00Z on the 2nd is already the 3rd, 00:00, in Prague.
    expect(localDayKeyInZone(PRAGUE, "2026-10-02T22:00:00.000Z")).toBe("2026-10-03");
    // The same instant is still the 2nd in New York.
    expect(localDayKeyInZone(NEW_YORK, "2026-10-02T22:00:00.000Z")).toBe("2026-10-02");
  });

  it("keeps the spring-forward day to one day even though it has 23 hours", () => {
    // Prague moves 02:00 → 03:00 on Sunday 2026-03-29, so that local day runs
    // from 2026-03-28T23:00Z to 2026-03-29T22:00Z: 23 real hours.
    const dayStart = "2026-03-28T23:00:00.000Z";
    const nextDayStart = "2026-03-29T22:00:00.000Z";

    expect((Date.parse(nextDayStart) - Date.parse(dayStart)) / 3_600_000).toBe(23);
    expect(localDayKeyInZone(PRAGUE, dayStart)).toBe("2026-03-29");
    expect(localDayKeyInZone(PRAGUE, new Date(Date.parse(nextDayStart) - 1).toISOString())).toBe(
      "2026-03-29",
    );
    expect(localDayKeyInZone(PRAGUE, nextDayStart)).toBe("2026-03-30");
    // 23 real hours later is the next calendar day — exactly one step.
    expect(shiftDayKey(localDayKeyInZone(PRAGUE, dayStart) as string, 1)).toBe(
      localDayKeyInZone(PRAGUE, nextDayStart),
    );
  });

  it("keeps the fall-back day to one day even though it has 25 hours", () => {
    // Prague moves 03:00 → 02:00 on Sunday 2026-10-25, so that local day runs
    // from 2026-10-24T22:00Z to 2026-10-25T23:00Z: 25 real hours.
    const dayStart = "2026-10-24T22:00:00.000Z";
    const nextDayStart = "2026-10-25T23:00:00.000Z";

    expect((Date.parse(nextDayStart) - Date.parse(dayStart)) / 3_600_000).toBe(25);
    expect(localDayKeyInZone(PRAGUE, dayStart)).toBe("2026-10-25");
    expect(localDayKeyInZone(PRAGUE, nextDayStart)).toBe("2026-10-26");
  });

  it("counts sends inside a 23-hour day as a single active day", () => {
    // 00:30 and 23:30 local on the short day, 23 hours apart in reality. The day
    // starts 2026-03-28T23:00Z and ends 2026-03-29T22:00Z.
    const result = metrics(
      keysOf(["2026-03-28T23:30:00.000Z", "2026-03-29T21:30:00.000Z"]),
      "2026-03-29",
    );

    expect(result.totalActiveDays).toBe(1);
  });

  it("counts sends inside a 25-hour day as a single active day", () => {
    // 00:30 and 23:30 local on the long day, 25 hours apart in reality.
    const result = metrics(
      keysOf(["2026-10-24T22:30:00.000Z", "2026-10-25T21:30:00.000Z"]),
      "2026-10-25",
    );

    expect(result.totalActiveDays).toBe(1);
  });

  it("keeps a run unbroken across the Prague spring transition", () => {
    // Four consecutive local days spanning the 23-hour day.
    const result = metrics(
      keysOf([
        "2026-03-26T09:00:00.000Z",
        "2026-03-27T09:00:00.000Z",
        "2026-03-28T09:00:00.000Z",
        "2026-03-28T23:30:00.000Z",
        "2026-03-29T21:30:00.000Z",
      ]),
      "2026-03-29",
    );

    expect(result.currentStreak).toBe(4);
    expect(result.longestStreak).toBe(4);
    expect(result.totalActiveDays).toBe(4);
  });

  it("keeps a run unbroken across the Prague fall transition", () => {
    const result = metrics(
      keysOf([
        "2026-10-23T09:00:00.000Z",
        "2026-10-24T09:00:00.000Z",
        "2026-10-24T22:30:00.000Z",
        "2026-10-25T21:30:00.000Z",
        "2026-10-26T09:00:00.000Z",
      ]),
      "2026-10-26",
    );

    expect(result.currentStreak).toBe(4);
    expect(result.longestStreak).toBe(4);
  });

  it("breaks a run at the spring transition when a day really was missed", () => {
    // The transition does not paper over a genuine gap.
    const result = metrics(
      keysOf(["2026-03-27T09:00:00.000Z", "2026-03-29T12:00:00.000Z"]),
      "2026-03-29",
    );

    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
  });

  it("handles a non-whole-hour offset without a day shifting by one", () => {
    // Kathmandu is UTC+05:45 all year: no DST, and no 24-hour assumption. Its
    // local midnight is 18:15Z, a quarter hour no whole-hour offset can express.
    expect(localDayKeyInZone(KATHMANDU, "2026-10-07T18:14:00.000Z")).toBe("2026-10-07");
    expect(localDayKeyInZone(KATHMANDU, "2026-10-07T18:15:00.000Z")).toBe("2026-10-08");

    const result = computeStreakMetrics({
      dayKeys: keysOf(["2026-10-06T20:00:00.000Z", "2026-10-07T20:00:00.000Z"], KATHMANDU),
      todayKey: "2026-10-08",
      ...EMPTY_RANGES,
    });

    expect(result.currentStreak).toBe(2);
  });

  it("handles a zone with a half-hour daylight-saving step", () => {
    // Lord Howe shifts by 30 minutes, so its transition day is neither 23 nor
    // 25 hours long. It still resolves to exactly one calendar day.
    const start = "2026-10-03T14:30:00.000Z"; // 2026-10-04 02:00 local
    const nextStart = "2026-10-04T13:30:00.000Z"; // 2026-10-05 00:00 local

    expect(localDayKeyInZone(LORD_HOWE, start)).toBe("2026-10-04");
    expect(localDayKeyInZone(LORD_HOWE, nextStart)).toBe("2026-10-05");
    expect(shiftDayKey("2026-10-04", 1)).toBe("2026-10-05");
  });

  it("handles a zone whose local midnight does not exist on a transition day", () => {
    // Santiago jumps 00:00 → 01:00 on 2026-09-06. The day still starts, one
    // instant later than a naive midnight, and is still one day.
    const windows = resolveStatsWindows(SANTIAGO, new Date("2026-09-06T18:00:00.000Z"));

    expect(localDayKeyInZone(SANTIAGO, windows.dayStart)).toBe("2026-09-06");
    expect(localDayKeyInZone(SANTIAGO, new Date(Date.parse(windows.dayStart) - 1).toISOString())).toBe(
      "2026-09-05",
    );
  });

  it("handles a zone that skipped a whole calendar date", () => {
    // Apia moved the date line in 2011 and never saw 2011-12-30. There is no
    // key for it, and a run either side of it is broken rather than invented.
    const result = computeStreakMetrics({
      dayKeys: keysOf(["2011-12-29T12:00:00.000Z", "2011-12-30T12:00:00.000Z"], "Pacific/Apia"),
      todayKey: "2011-12-31",
      weekStartKey: "2011-12-26",
      weekEndKey: "2012-01-01",
      monthStartKey: "2011-12-01",
      monthEndKey: "2012-01-01",
    });

    expect(result.totalActiveDays).toBe(2);
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
  });
});

describe("streaks and windows agree about the current week and month", () => {
  it("places Monday and Sunday in the same window the Stats windows describe", () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);

    // The range this file pins by hand is the range Stats resolves.
    expect(localDayKeyInZone(PRAGUE, windows.weekStart)).toBe(EMPTY_RANGES.weekStartKey);
    expect(localDayKeyInZone(PRAGUE, windows.nextWeekStart)).toBe(EMPTY_RANGES.weekEndKey);
    expect(localDayKeyInZone(PRAGUE, windows.monthStart)).toBe(EMPTY_RANGES.monthStartKey);
    expect(localDayKeyInZone(PRAGUE, windows.nextMonthStart)).toBe(EMPTY_RANGES.monthEndKey);
  });

  it("places a send inside the current week for both surfaces", () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    const sentAt = windows.weekStart;

    const result = computeStreakMetrics({
      dayKeys: keysOf([sentAt]),
      todayKey: localDayKeyInZone(PRAGUE, NOW) as string,
      weekStartKey: EMPTY_RANGES.weekStartKey,
      weekEndKey: EMPTY_RANGES.weekEndKey,
      monthStartKey: EMPTY_RANGES.monthStartKey,
      monthEndKey: EMPTY_RANGES.monthEndKey,
    });

    expect(result.activeDaysThisWeek).toBe(1);
    expect(result.activeDaysThisMonth).toBe(1);
  });
});