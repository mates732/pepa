import { describe, expect, it } from "vitest";

import {
  isValidTimeZone,
  isWithin,
  localDayKeyInZone,
  resolveStatsWindows,
} from "@/lib/outreach/stats-windows";

/**
 * Tests for the Stats calendar windows.
 *
 * Every case pins an explicit instant, never `Date.now()`, so the expectations
 * describe the rule rather than whatever day the suite happened to run on.
 *
 * Europe/Prague is used because it is the operator's, but nothing in the
 * implementation is Prague-specific: a second zone with a different offset and
 * the opposite DST rules is asserted alongside it precisely so that a fixed
 * offset, or a hard-coded +01:00, would fail here.
 */

const PRAGUE = "Europe/Prague";
const NEW_YORK = "America/New_York";
/** No DST at all: a useful control for "is this offset hard-coded?". */
const KATHMANDU = "Asia/Kathmandu";
/** Clocks jump forward at local midnight, so that midnight never happens. */
const SANTIAGO = "America/Santiago";
/** A 30-minute daylight-saving step, and no whole-hour offset either. */
const LORD_HOWE = "Australia/Lord_Howe";

/** Wall-clock time in a zone, as an absolute instant. */
function instantIn(timeZone: string, year: number, month: number, day: number, hour = 0, minute = 0) {
  // Search for the instant whose local rendering matches the requested fields.
  // Deliberately brute force: it derives the instant from the same formatter the
  // implementation uses, so a mistake in the offset math cannot hide here.
  for (let ms = 0; ms <= 26 * 3_600_000; ms += 60_000) {
    const candidate = Date.UTC(year, month - 1, day, hour, minute) - 14 * 3_600_000 + ms;
    const rendered = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(candidate));
    if (rendered.includes(`${day < 10 ? "0" + day : day}`)) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(new Date(candidate));
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      if (get("year") === year && get("month") === month && get("day") === day && get("hour") === hour && get("minute") === minute) {
        return new Date(candidate);
      }
    }
  }
  throw new Error(`no instant for ${year}-${month}-${day} ${hour}:${minute} in ${timeZone}`);
}

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone(PRAGUE)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone(NEW_YORK)).toBe(true);
  });

  it("rejects anything else without throwing", () => {
    for (const bad of ["", "Mars/Olympus", "x".repeat(200), null, undefined, 42, {}]) {
      expect(isValidTimeZone(bad)).toBe(false);
    }
  });
});

describe("resolveStatsWindows — day", () => {
  it("starts the day at local midnight", () => {
    const noon = instantIn(PRAGUE, 2026, 10, 3, 12, 0);
    const windows = resolveStatsWindows(PRAGUE, noon);

    // Midnight local is 22:00 UTC the previous evening while Prague is on CEST.
    expect(windows.dayStart).toBe("2026-10-02T22:00:00.000Z");
    expect(windows.nextDayStart).toBe("2026-10-03T22:00:00.000Z");
  });

  it("moves the boundary when daylight saving ends", () => {
    // Prague leaves CEST for CET at 03:00 local on 2026-10-25, so that day's
    // midnight is still +02:00 while the next day's is +01:00. A fixed offset
    // cannot produce these two different answers.
    const noon = instantIn(PRAGUE, 2026, 10, 25, 12, 0);
    const windows = resolveStatsWindows(PRAGUE, noon);

    expect(windows.dayStart).toBe("2026-10-24T22:00:00.000Z");
    expect(windows.nextDayStart).toBe("2026-10-25T23:00:00.000Z");
  });

  it("moves the boundary when daylight saving starts", () => {
    // 2026-03-29: Prague springs forward, so that midnight is +01:00.
    const noon = instantIn(PRAGUE, 2026, 3, 29, 12, 0);
    const windows = resolveStatsWindows(PRAGUE, noon);

    expect(windows.dayStart).toBe("2026-03-28T23:00:00.000Z");
  });

  it("resolves a different zone to a different boundary", () => {
    const utcNoon = new Date("2026-10-03T12:00:00.000Z");

    expect(resolveStatsWindows(PRAGUE, utcNoon).dayStart).toBe("2026-10-02T22:00:00.000Z");
    expect(resolveStatsWindows(NEW_YORK, utcNoon).dayStart).toBe("2026-10-03T04:00:00.000Z");
    // +05:45, an offset no whole-hour assumption could produce. 12:00 UTC is
    // already 17:45 on the 3rd in Kathmandu, so that day's midnight was the
    // previous evening.
    expect(resolveStatsWindows(KATHMANDU, utcNoon).dayStart).toBe("2026-10-02T18:15:00.000Z");
  });

  it("gives the same instant two different days in two zones", () => {
    // 23:30 UTC: still the 3rd in Prague, already the 4th in New York.
    const late = new Date("2026-10-03T23:30:00.000Z");

    expect(resolveStatsWindows(PRAGUE, late).dayStart).toBe("2026-10-03T22:00:00.000Z");
    expect(resolveStatsWindows(NEW_YORK, late).dayStart).toBe("2026-10-03T04:00:00.000Z");
  });

  it("rejects an unknown zone", () => {
    expect(() => resolveStatsWindows("Mars/Olympus", new Date())).toThrow(RangeError);
  });
});

describe("resolveStatsWindows — week", () => {
  it("starts on Monday at local midnight", () => {
    // Wednesday 2026-10-07.
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2026, 10, 7, 12, 0));

    expect(windows.weekStart).toBe("2026-10-04T22:00:00.000Z");
    expect(windows.nextWeekStart).toBe("2026-10-11T22:00:00.000Z");
  });

  it("treats Monday itself as the start of its own week", () => {
    const mondayNoon = instantIn(PRAGUE, 2026, 10, 5, 12, 0);
    const windows = resolveStatsWindows(PRAGUE, mondayNoon);

    expect(windows.weekStart).toBe("2026-10-04T22:00:00.000Z");
    expect(windows.nextWeekStart).toBe("2026-10-11T22:00:00.000Z");
  });

  it("puts Sunday at the end of the week, not the start of a new one", () => {
    // Sunday 2026-10-11 — the ISO trap. Monday-start puts it in the week that
    // began on the 5th.
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2026, 10, 11, 12, 0));

    expect(windows.weekStart).toBe("2026-10-04T22:00:00.000Z");
    expect(windows.nextWeekStart).toBe("2026-10-11T22:00:00.000Z");
  });

  it("spans a year boundary without losing a day", () => {
    // Wednesday 2027-01-06; that week began on Monday 2027-01-04.
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2027, 1, 6, 12, 0));

    expect(windows.weekStart).toBe("2027-01-03T23:00:00.000Z");
    expect(windows.nextWeekStart).toBe("2027-01-10T23:00:00.000Z");
  });

  it("keeps the week boundary in local midnight across a DST change", () => {
    // The week of 2026-10-19 contains the 25th, when Prague leaves CEST. Both
    // ends are local midnight; only the first is +02:00.
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2026, 10, 21, 12, 0));

    expect(windows.weekStart).toBe("2026-10-18T22:00:00.000Z");
    expect(windows.nextWeekStart).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("resolveStatsWindows — month", () => {
  it("starts on the first of the month at local midnight", () => {
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2026, 10, 17, 12, 0));

    expect(windows.monthStart).toBe("2026-09-30T22:00:00.000Z");
    expect(windows.nextMonthStart).toBe("2026-10-31T23:00:00.000Z");
  });

  it("is a calendar month, not a rolling 30 days", () => {
    // Mid-April: a rolling 30-day window would begin on 16 March. This one begins
    // on the first, so every send earlier in the month is counted.
    const now = instantIn(PRAGUE, 2026, 4, 15, 12, 0);
    const windows = resolveStatsWindows(PRAGUE, now);

    // 1 April 00:00 CEST and 1 May 00:00 CEST.
    expect(windows.monthStart).toBe("2026-03-31T22:00:00.000Z");
    expect(windows.nextMonthStart).toBe("2026-04-30T22:00:00.000Z");
    expect(Date.parse(windows.monthStart)).not.toBe(now.getTime() - 30 * 86_400_000);
  });

  it("rolls December into January of the next year", () => {
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2026, 12, 15, 12, 0));

    expect(windows.monthStart).toBe("2026-11-30T23:00:00.000Z");
    expect(windows.nextMonthStart).toBe("2026-12-31T23:00:00.000Z");
  });

  it("handles February in a leap year", () => {
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2028, 2, 10, 12, 0));

    expect(windows.monthStart).toBe("2028-01-31T23:00:00.000Z");
    expect(windows.nextMonthStart).toBe("2028-02-29T23:00:00.000Z");
  });

  it("handles February in a common year", () => {
    const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2026, 2, 10, 12, 0));

    expect(windows.nextMonthStart).toBe("2026-02-28T23:00:00.000Z");
  });
});

describe("isWithin", () => {
  const windows = resolveStatsWindows(PRAGUE, instantIn(PRAGUE, 2026, 10, 7, 12, 0));

  it("includes the start instant and excludes the end instant", () => {
    // Half-open, so a send exactly at midnight belongs to exactly one window
    // and can never be counted in two.
    expect(isWithin(windows.dayStart, windows.dayStart, windows.nextDayStart)).toBe(true);
    expect(isWithin(windows.nextDayStart, windows.dayStart, windows.nextDayStart)).toBe(false);
    // One millisecond earlier is still the previous day.
    const justBefore = new Date(Date.parse(windows.dayStart) - 1).toISOString();
    expect(isWithin(justBefore, windows.dayStart, windows.nextDayStart)).toBe(false);
  });

  it("treats an unparseable timestamp as outside every window", () => {
    expect(isWithin("not-a-date", windows.dayStart, windows.nextDayStart)).toBe(false);
  });
});
describe("localDayKeyInZone", () => {
  it("names the local calendar day an instant falls on", () => {
    expect(localDayKeyInZone(PRAGUE, "2026-10-07T09:00:00.000Z")).toBe("2026-10-07");
    expect(localDayKeyInZone(PRAGUE, new Date("2026-10-07T09:00:00.000Z"))).toBe("2026-10-07");
    expect(localDayKeyInZone(PRAGUE, Date.parse("2026-10-07T09:00:00.000Z"))).toBe("2026-10-07");
  });

  it("changes key exactly at local midnight, not at a fixed UTC hour", () => {
    // Prague midnight is 22:00Z in summer and 23:00Z in winter. A hard-coded
    // offset would put one of these on the wrong day.
    expect(localDayKeyInZone(PRAGUE, "2026-10-06T21:59:59.000Z")).toBe("2026-10-06");
    expect(localDayKeyInZone(PRAGUE, "2026-10-06T22:00:00.000Z")).toBe("2026-10-07");
    expect(localDayKeyInZone(PRAGUE, "2026-01-05T22:59:59.000Z")).toBe("2026-01-05");
    expect(localDayKeyInZone(PRAGUE, "2026-01-05T23:00:00.000Z")).toBe("2026-01-06");
  });

  it("files the same instant under different days in different zones", () => {
    const instant = "2026-10-02T22:00:00.000Z";
    expect(localDayKeyInZone(PRAGUE, instant)).toBe("2026-10-03");
    expect(localDayKeyInZone(NEW_YORK, instant)).toBe("2026-10-02");
    expect(localDayKeyInZone(KATHMANDU, instant)).toBe("2026-10-03");
  });

  it("resolves a quarter-hour offset, which no whole-hour offset can express", () => {
    // Kathmandu is UTC+05:45 with no DST; its midnight is 18:15Z.
    expect(localDayKeyInZone(KATHMANDU, "2026-10-07T18:14:00.000Z")).toBe("2026-10-07");
    expect(localDayKeyInZone(KATHMANDU, "2026-10-07T18:15:00.000Z")).toBe("2026-10-08");
  });

  it("gives a 23-hour day and a 25-hour day one key each", () => {
    // Prague 2026-03-29 has 23 real hours and 2026-10-25 has 25. Both are one
    // day, which is the whole point of counting in calendar days.
    expect(localDayKeyInZone(PRAGUE, "2026-03-28T23:00:00.000Z")).toBe("2026-03-29");
    expect(localDayKeyInZone(PRAGUE, "2026-03-29T21:59:59.000Z")).toBe("2026-03-29");
    expect(localDayKeyInZone(PRAGUE, "2026-03-29T22:00:00.000Z")).toBe("2026-03-30");

    expect(localDayKeyInZone(PRAGUE, "2026-10-24T22:00:00.000Z")).toBe("2026-10-25");
    expect(localDayKeyInZone(PRAGUE, "2026-10-25T22:59:59.000Z")).toBe("2026-10-25");
    expect(localDayKeyInZone(PRAGUE, "2026-10-25T23:00:00.000Z")).toBe("2026-10-26");
  });

  it("handles a half-hour daylight-saving step", () => {
    // Lord Howe is +10:30 and steps to +11:00 on 2026-10-04, so its 2026-10-04
    // begins at 2026-10-03T13:30Z. No whole-hour offset can place that.
    expect(localDayKeyInZone(LORD_HOWE, "2026-10-03T13:29:00.000Z")).toBe("2026-10-03");
    expect(localDayKeyInZone(LORD_HOWE, "2026-10-03T13:30:00.000Z")).toBe("2026-10-04");
    expect(localDayKeyInZone(LORD_HOWE, "2026-10-04T12:59:00.000Z")).toBe("2026-10-04");
    expect(localDayKeyInZone(LORD_HOWE, "2026-10-04T13:00:00.000Z")).toBe("2026-10-05");
  });

  it("agrees with the resolved day window on both sides of a transition", () => {
    for (const [zone, now] of [
      [PRAGUE, "2026-03-29T12:00:00.000Z"],
      [PRAGUE, "2026-10-25T12:00:00.000Z"],
      [NEW_YORK, "2026-03-08T12:00:00.000Z"],
      [NEW_YORK, "2026-11-01T12:00:00.000Z"],
      [SANTIAGO, "2026-09-06T18:00:00.000Z"],
      [LORD_HOWE, "2026-10-04T12:00:00.000Z"],
    ] as const) {
      const windows = resolveStatsWindows(zone, new Date(now));
      const justBefore = new Date(Date.parse(windows.dayStart) - 1).toISOString();

      expect(localDayKeyInZone(zone, windows.dayStart)).toBe(localDayKeyInZone(zone, now));
      expect(localDayKeyInZone(zone, justBefore)).not.toBe(localDayKeyInZone(zone, now));
      expect(localDayKeyInZone(zone, windows.nextDayStart)).not.toBe(localDayKeyInZone(zone, now));
    }
  });

  it("returns null rather than a guessed date for unusable input", () => {
    expect(localDayKeyInZone("Mars/Olympus", "2026-10-07T09:00:00.000Z")).toBeNull();
    expect(localDayKeyInZone(PRAGUE, "not-a-date")).toBeNull();
    expect(localDayKeyInZone("", "2026-10-07T09:00:00.000Z")).toBeNull();
  });
});

describe("resolveStatsWindows — a zone whose local midnight does not exist", () => {
  it("starts the day at the first instant that does exist on it", () => {
    // Santiago jumps 00:00 to 01:00 on 2026-09-06. The day must still begin on
    // the 6th: starting it an hour early would file the last hour of the 5th
    // into the 6th.
    const windows = resolveStatsWindows(SANTIAGO, instantIn(SANTIAGO, 2026, 9, 6, 18, 0));

    expect(localDayKeyInZone(SANTIAGO, windows.dayStart)).toBe("2026-09-06");
    expect(localDayKeyInZone(SANTIAGO, new Date(Date.parse(windows.dayStart) - 1).toISOString())).toBe(
      "2026-09-05",
    );
    expect(localDayKeyInZone(SANTIAGO, windows.nextDayStart)).toBe("2026-09-07");
  });
});
