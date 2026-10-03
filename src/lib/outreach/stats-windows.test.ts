import { describe, expect, it } from "vitest";

import { isValidTimeZone, isWithin, resolveStatsWindows } from "@/lib/outreach/stats-windows";

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