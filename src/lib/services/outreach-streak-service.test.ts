import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveStatsWindows } from "@/lib/outreach/stats-windows";

/**
 * Tests for the Outreach Streaks service.
 *
 * The clock is pinned per test, exactly as the Stats service tests pin theirs:
 * a streak is entirely about *when* outreach went out, so a test leaning on the
 * wall clock would quietly stop meaning what it said the day the suite ran.
 *
 * The store fake here understands `order`, because the newest-first ordering is
 * part of what the service promises: under a cap, today's rows are the ones that
 * stay in the scan.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase, stats } = vi.hoisted(() => {
  const db = { messages: [] as Row[] };
  // Query and mutation counters. These are what prove the read is one bounded
  // query and that nothing is ever written.
  const stats = {
    queries: 0,
    writes: [] as string[],
    failWith: null as { message: string } | null,
    lastSelect: "",
  };

  function readBuilder(
    filters: Array<[string, unknown]>,
    order: { column: string; ascending: boolean } | null,
    limit: number | null,
    projected: string[],
  ) {
    const matched = (): Row[] => {
      const filtered = db.messages.filter((row) =>
        filters.every(([column, value]) => {
          // PostgREST's `not.is.null` is exactly this: the column is not null.
          if (value === "__not_null__") return row[column] !== null && row[column] !== undefined;
          return row[column] === value;
        }),
      );

      const by = order;
      const sorted = by
        ? [...filtered].sort((a, b) => {
            const left = String(a[by.column] ?? "");
            const right = String(b[by.column] ?? "");
            return by.ascending ? left.localeCompare(right) : right.localeCompare(left);
          })
        : filtered;

      return limit === null ? sorted : sorted.slice(0, limit);
    };

    stats.queries += 1;
    // What the query asked for, so "only the columns a streak needs" is an
    // assertion rather than a claim.
    stats.lastSelect = projected.join(",");

    const builder: Record<string, unknown> = {};
    builder.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    };
    builder.not = (column: string, operator: string) => {
      if (operator !== "is") throw new Error(`unsupported operator ${operator}`);
      filters.push([column, "__not_null__"]);
      return builder;
    };
    builder.order = (column: string, options?: { ascending?: boolean }) => {
      order = { column, ascending: options?.ascending ?? true };
      return builder;
    };
    builder.limit = (n: number) => {
      limit = n;
      return builder;
    };
    builder.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(
        onFulfilled(
          stats.failWith ? { data: null, error: stats.failWith } : { data: matched(), error: null },
        ),
      );

    return builder;
  }

  function makeSupabase() {
    return {
      from() {
        return {
          select: (projection: string) => readBuilder([], null, null, projection.split(",")),
          insert: () => {
            stats.writes.push("INSERT");
            throw new Error("streaks must not write");
          },
          update: () => {
            stats.writes.push("UPDATE");
            throw new Error("streaks must not write");
          },
          upsert: () => {
            stats.writes.push("UPSERT");
            throw new Error("streaks must not write");
          },
          delete: () => {
            stats.writes.push("DELETE");
            throw new Error("streaks must not write");
          },
        };
      },
    };
  }

  return { db, makeSupabase: () => makeSupabase(), stats };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

const PRAGUE = "Europe/Prague";
const NEW_YORK = "America/New_York";

/** Wednesday 2026-10-07, 12:00 local. Midweek, mid-month, no DST edge. */
const NOW = new Date("2026-10-07T10:00:00.000Z");

/** Today, this week and this month, as absolute instants. */
const TODAY = "2026-10-07T08:00:00.000Z";
const YESTERDAY = "2026-10-06T08:00:00.000Z";
const THIS_WEEK = "2026-10-05T08:00:00.000Z";
const LAST_WEEK = "2026-10-02T08:00:00.000Z";
const THIS_MONTH = "2026-10-01T08:00:00.000Z";
const LAST_MONTH = "2026-09-28T08:00:00.000Z";

function seedMessage(overrides: Row = {}) {
  db.messages.push({ status: "sent", sent_at: TODAY, ...overrides });
}

async function load() {
  return import("@/lib/services/outreach-streak-service");
}

async function readStreaks(now: Date = NOW) {
  const { getOutreachStreaks } = await load();
  const result = await getOutreachStreaks({ timeZone: PRAGUE, now });
  if (!result.ok || !result.data) throw new Error(result.error ?? "streaks failed");
  return result.data;
}

beforeEach(() => {
  db.messages = [];
  stats.queries = 0;
  stats.writes = [];
  stats.failWith = null;
  stats.lastSelect = "";
});

describe("streaks — zero state", () => {
  it("reports every figure as zero when nothing has been sent", async () => {
    const result = await readStreaks();

    expect(result).toMatchObject({
      currentStreak: 0,
      longestStreak: 0,
      activeDaysThisWeek: 0,
      activeDaysThisMonth: 0,
      totalActiveDays: 0,
      complete: true,
      currentStreakComplete: true,
    });
  });

  it("is all zero even when unsent rows exist", async () => {
    seedMessage({ status: "draft", sent_at: null });
    seedMessage({ status: "ready", sent_at: null });

    expect((await readStreaks()).totalActiveDays).toBe(0);
  });
});

describe("streaks — what makes a day active", () => {
  it("counts a send today as one active day", async () => {
    seedMessage();

    const result = await readStreaks();

    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
    expect(result.activeDaysThisWeek).toBe(1);
    expect(result.activeDaysThisMonth).toBe(1);
  });

  it("counts five sends today as one active day, not five", async () => {
    for (const sentAt of [
      "2026-10-06T23:00:00.000Z",
      "2026-10-07T03:00:00.000Z",
      "2026-10-07T07:00:00.000Z",
      "2026-10-07T12:00:00.000Z",
      "2026-10-07T19:00:00.000Z",
    ]) {
      seedMessage({ sent_at: sentAt });
    }

    const result = await readStreaks();

    expect(result.totalActiveDays).toBe(1);
    expect(result.currentStreak).toBe(1);
    expect(result.activeDaysThisWeek).toBe(1);
    // Stats counts the same five as five sends; streaks counts one day. Both
    // are true, and neither is derived from the other.
    expect(result.activeDaysThisWeek).toBeLessThanOrEqual(result.totalActiveDays);
  });

  it("excludes a draft", async () => {
    seedMessage({ status: "draft", sent_at: TODAY });

    expect((await readStreaks()).totalActiveDays).toBe(0);
  });

  it("excludes a sent row with no sent_at, because it cannot be placed on a day", async () => {
    seedMessage({ status: "sent", sent_at: null });

    const result = await readStreaks();
    expect(result.totalActiveDays).toBe(0);
    expect(result.currentStreak).toBe(0);
  });

  it("excludes a non-sent row that nonetheless carries a sent_at", async () => {
    for (const status of ["draft", "ready", "replied", "follow_up", "completed", "blocked"]) {
      seedMessage({ status, sent_at: TODAY });
    }

    expect((await readStreaks()).totalActiveDays).toBe(0);
  });

  it("excludes a row whose sent_at is unparseable", async () => {
    seedMessage({ status: "sent", sent_at: "not-a-date" });

    expect((await readStreaks()).totalActiveDays).toBe(0);
  });
});

describe("streaks — the current streak ends today", () => {
  it("is 1 for today alone", async () => {
    seedMessage();

    expect((await readStreaks()).currentStreak).toBe(1);
  });

  it("is 2 for today and yesterday", async () => {
    seedMessage({ sent_at: YESTERDAY });
    seedMessage();

    expect((await readStreaks()).currentStreak).toBe(2);
  });

  it("is 3 across three consecutive local days", async () => {
    seedMessage({ sent_at: "2026-10-05T08:00:00.000Z" });
    seedMessage({ sent_at: YESTERDAY });
    seedMessage();

    expect((await readStreaks()).currentStreak).toBe(3);
  });

  it("stops at a gap", async () => {
    seedMessage({ sent_at: "2026-10-04T08:00:00.000Z" });
    seedMessage({ sent_at: YESTERDAY });
    seedMessage();

    const result = await readStreaks();
    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(2);
  });

  it("is 0 when today has no send", async () => {
    seedMessage({ sent_at: YESTERDAY });
    seedMessage({ sent_at: "2026-10-05T08:00:00.000Z" });

    expect((await readStreaks()).currentStreak).toBe(0);
  });

  it("does not carry a streak that ended yesterday into today", async () => {
    // Yesterday through Saturday is a four-day run, and it is over.
    for (const day of ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]) {
      seedMessage({ sent_at: `${day}T08:00:00.000Z` });
    }

    const result = await readStreaks();
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(4);
  });

  it("is not inflated by several sends today", async () => {
    seedMessage();
    seedMessage();
    seedMessage();
    seedMessage({ sent_at: YESTERDAY });

    expect((await readStreaks()).currentStreak).toBe(2);
  });

  it("counts a send late in the evening as today, not as the next day", async () => {
    // 23:00 local on the 7th is 21:00Z on the 7th in Prague.
    seedMessage({ sent_at: "2026-10-07T21:00:00.000Z" });

    const result = await readStreaks();
    expect(result.currentStreak).toBe(1);
    expect(result.totalActiveDays).toBe(1);
  });

  it("does not count a send that lands exactly at tomorrow's midnight", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.nextDayStart });

    const result = await readStreaks();
    expect(result.currentStreak).toBe(0);
    // It is still an active day, and it is still the same total.
    expect(result.totalActiveDays).toBe(1);
  });

  it("counts a send at the very start of today", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.dayStart });

    expect((await readStreaks()).currentStreak).toBe(1);
  });
});

describe("streaks — the longest run in the history", () => {
  it("is 1 for a single active day in the past", async () => {
    seedMessage({ sent_at: LAST_MONTH });

    const result = await readStreaks();
    expect(result.longestStreak).toBe(1);
    expect(result.currentStreak).toBe(0);
  });

  it("is the length of a consecutive run", async () => {
    for (const day of ["2026-09-28", "2026-09-29", "2026-09-30"]) {
      seedMessage({ sent_at: `${day}T08:00:00.000Z` });
    }

    expect((await readStreaks()).longestStreak).toBe(3);
  });

  it("picks the longest of several runs and ignores order", async () => {
    // Thu–Fri, Sat inactive, Sun–Mon–Tue, Wed inactive.
    for (const day of ["2026-09-24", "2026-09-25", "2026-09-27", "2026-09-28", "2026-09-29"]) {
      seedMessage({ sent_at: `${day}T08:00:00.000Z` });
    }

    expect((await readStreaks()).longestStreak).toBe(3);
  });

  it("keeps an earlier longer run when a later shorter one arrives", async () => {
    for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-10-05", "2026-10-06"]) {
      seedMessage({ sent_at: `${day}T08:00:00.000Z` });
    }

    expect((await readStreaks()).longestStreak).toBe(3);
  });

  it("is not inflated by duplicate sends on one day", async () => {
    seedMessage({ sent_at: "2026-09-28T08:00:00.000Z" });
    seedMessage({ sent_at: "2026-09-28T12:00:00.000Z" });
    seedMessage({ sent_at: "2026-09-29T08:00:00.000Z" });
    seedMessage({ sent_at: "2026-09-29T20:00:00.000Z" });

    const result = await readStreaks();
    expect(result.longestStreak).toBe(2);
    expect(result.totalActiveDays).toBe(2);
  });
});

describe("streaks — week and month windows agree with Stats", () => {
  it("counts Monday, the first day of the week", async () => {
    seedMessage({ sent_at: THIS_WEEK });

    const result = await readStreaks();
    expect(result.activeDaysThisWeek).toBe(1);
    expect(result.currentStreak).toBe(0);
  });

  it("counts Sunday, the last day of the week", async () => {
    const sunday = new Date("2026-10-11T10:00:00.000Z");
    seedMessage({ sent_at: "2026-10-11T08:00:00.000Z" });

    const result = await readStreaks(sunday);
    expect(result.activeDaysThisWeek).toBe(1);
    expect(result.currentStreak).toBe(1);
  });

  it("excludes the last day of the previous week", async () => {
    seedMessage({ sent_at: LAST_WEEK });

    const result = await readStreaks();
    expect(result.activeDaysThisWeek).toBe(0);
    expect(result.activeDaysThisMonth).toBe(1);
  });

  it("excludes the first day of the next week", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.nextWeekStart });

    const result = await readStreaks();
    expect(result.activeDaysThisWeek).toBe(0);
    expect(result.activeDaysThisMonth).toBe(1);
  });

  it("counts the first day of the month", async () => {
    seedMessage({ sent_at: THIS_MONTH });

    const result = await readStreaks();
    expect(result.activeDaysThisMonth).toBe(1);
    expect(result.activeDaysThisWeek).toBe(0);
  });

  it("excludes the last day of the previous month", async () => {
    seedMessage({ sent_at: LAST_MONTH });

    const result = await readStreaks();
    expect(result.activeDaysThisMonth).toBe(0);
    expect(result.totalActiveDays).toBe(1);
  });

  it("excludes the first day of the next month", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.nextMonthStart });

    expect((await readStreaks()).activeDaysThisMonth).toBe(0);
  });

  it("reports the month length the window describes", async () => {
    expect((await readStreaks()).daysInMonth).toBe(31);
    expect((await readStreaks()).daysInWeek).toBe(7);

    // February 2028: a leap month resolved from the same windows.
    const leap = new Date("2028-02-10T10:00:00.000Z");
    expect((await readStreaks(leap)).daysInMonth).toBe(29);
  });

  it("deduplicates the week and the month", async () => {
    for (const sentAt of [
      "2026-10-06T23:00:00.000Z",
      "2026-10-07T05:00:00.000Z",
      "2026-10-07T11:00:00.000Z",
      "2026-10-07T17:00:00.000Z",
    ]) {
      seedMessage({ sent_at: sentAt });
    }

    const result = await readStreaks();
    expect(result.activeDaysThisWeek).toBe(1);
    expect(result.activeDaysThisMonth).toBe(1);
    expect(result.totalActiveDays).toBe(1);
  });
});

describe("streaks — daylight saving through the service", () => {
  it("keeps a run unbroken across the Prague spring transition", async () => {
    // Today is 2026-03-29, the 23-hour day itself.
    const now = new Date("2026-03-29T12:00:00.000Z");
    seedMessage({ sent_at: "2026-03-26T09:00:00.000Z" });
    seedMessage({ sent_at: "2026-03-27T09:00:00.000Z" });
    seedMessage({ sent_at: "2026-03-28T09:00:00.000Z" });
    // Two sends inside the short day itself: 00:30 and 23:30 local.
    seedMessage({ sent_at: "2026-03-28T23:30:00.000Z" });
    seedMessage({ sent_at: "2026-03-29T21:30:00.000Z" });

    const result = await readStreaks(now);
    expect(result.currentStreak).toBe(4);
    expect(result.longestStreak).toBe(4);
    expect(result.totalActiveDays).toBe(4);
  });

  it("keeps a run unbroken across the Prague autumn transition", async () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    seedMessage({ sent_at: "2026-10-23T09:00:00.000Z" });
    seedMessage({ sent_at: "2026-10-24T09:00:00.000Z" });
    seedMessage({ sent_at: "2026-10-24T22:30:00.000Z" });
    seedMessage({ sent_at: "2026-10-25T21:30:00.000Z" });
    seedMessage({ sent_at: "2026-10-26T09:00:00.000Z" });

    const result = await readStreaks(now);
    expect(result.currentStreak).toBe(4);
    expect(result.longestStreak).toBe(4);
    expect(result.totalActiveDays).toBe(4);
  });

  it("files the same send on different days in different zones", async () => {
    // 2026-10-02T22:00:00Z is midnight on the 3rd in Prague and 18:00 on the 2nd
    // in New York. It is today in one reader's calendar and yesterday in the
    // other's, and each reader is told the truth about their own.
    const now = new Date("2026-10-03T12:00:00.000Z");
    seedMessage({ sent_at: "2026-10-02T22:00:00.000Z" });

    const { getOutreachStreaks } = await load();
    const prague = await getOutreachStreaks({ timeZone: PRAGUE, now });
    const newYork = await getOutreachStreaks({ timeZone: NEW_YORK, now });

    expect(prague.data?.currentStreak).toBe(1);
    expect(prague.data?.totalActiveDays).toBe(1);
    expect(newYork.data?.currentStreak).toBe(0);
    expect(newYork.data?.totalActiveDays).toBe(1);

    // Adding a send that is yesterday in Prague extends Prague's run and leaves
    // New York with two separate days.
    seedMessage({ sent_at: "2026-10-02T08:00:00.000Z" });
    const pragueAgain = await getOutreachStreaks({ timeZone: PRAGUE, now });
    expect(pragueAgain.data?.currentStreak).toBe(2);
    expect(pragueAgain.data?.longestStreak).toBe(2);
  });
});

describe("streaks — completeness under the scan cap", () => {
  it("reports a complete scan below the cap", async () => {
    const { MAX_STATS_SCAN_ROWS, calculateStreaks } = await load();
    const windows = resolveStatsWindows(PRAGUE, NOW);

    const result = calculateStreaks(
      [{ status: "sent", sent_at: TODAY }],
      windows,
      NOW,
    );

    expect(result.complete).toBe(true);
    expect(result.currentStreakComplete).toBe(true);
    expect(MAX_STATS_SCAN_ROWS).toBe(50_000);
  });

  it("reports an incomplete scan at the cap rather than claiming a lifetime record", async () => {
    const { MAX_STATS_SCAN_ROWS, calculateStreaks } = await load();
    const windows = resolveStatsWindows(PRAGUE, NOW);

    const result = calculateStreaks(
      Array.from({ length: MAX_STATS_SCAN_ROWS }, () => ({ status: "sent", sent_at: TODAY })),
      windows,
      NOW,
    );

    expect(result.complete).toBe(false);
    // Every returned row is today's, so older rows may exist and the current
    // run itself cannot be certified either.
    expect(result.currentStreakComplete).toBe(false);
    expect(result.longestStreak).toBe(1);
  });

  it("keeps the current streak exact when the cap still covers the whole run", async () => {
    const { MAX_STATS_SCAN_ROWS, calculateStreaks } = await load();
    const windows = resolveStatsWindows(PRAGUE, NOW);

    // A capped scan that reaches back past today: today's rows come first in a
    // newest-first read, so the run ending today is fully covered and is exact,
    // while the historical longest streak is not.
    const rows = [
      ...Array.from({ length: MAX_STATS_SCAN_ROWS - 1 }, () => ({
        status: "sent",
        sent_at: "2026-01-01T08:00:00.000Z",
      })),
      { status: "sent", sent_at: YESTERDAY },
      { status: "sent", sent_at: TODAY },
    ];

    const result = calculateStreaks(rows, windows, NOW);

    expect(result.complete).toBe(false);
    expect(result.currentStreakComplete).toBe(true);
    expect(result.currentStreak).toBe(2);
  });

  it("reuses the Stats scan bound rather than a second constant", async () => {
    const streaks = await load();
    const stats = await import("@/lib/services/outreach-stats-service");

    expect(streaks.MAX_STATS_SCAN_ROWS).toBe(stats.MAX_STATS_SCAN_ROWS);
  });
});

describe("streaks — query behaviour", () => {
  it("reads once, whatever the number of sends", async () => {
    for (let i = 1; i <= 30; i += 1) {
      seedMessage({ sent_at: `2026-10-0${(i % 7) + 1}T08:00:00.000Z` });
    }

    await readStreaks();
    // A per-day or per-lead query would make this grow with the data.
    expect(stats.queries).toBe(1);
  });

  it("selects only the columns a streak needs", async () => {
    seedMessage();

    await readStreaks();

    // No subject, body, recipient, sequence_number or lead data: a streak needs
    // a status and a timestamp and nothing else.
    expect(stats.lastSelect).toBe("status, sent_at");
  });

  it("performs no write of any kind", async () => {
    seedMessage();

    await readStreaks();
    expect(stats.writes).toEqual([]);
  });

  it("rejects an unusable time zone without querying", async () => {
    const { getOutreachStreaks } = await load();
    const result = await getOutreachStreaks({ timeZone: "Mars/Olympus", now: NOW });

    expect(result.ok).toBe(false);
    expect(stats.queries).toBe(0);
  });

  it("contains a raw driver error, since the action echoes this message", async () => {
    stats.failWith = { message: 'relation "public.outreach_messages" does not exist' };

    const { getOutreachStreaks } = await load();
    const result = await getOutreachStreaks({ timeZone: PRAGUE, now: NOW });

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/relation|postgres|pg_|syntax/i);
    expect(result.error).toBe("Streaks could not be loaded.");
  });
});

describe("streaks — the counting function on its own", () => {
  it("re-checks the predicate even if a row bypasses the query", async () => {
    const { calculateStreaks } = await load();
    const windows = resolveStatsWindows(PRAGUE, NOW);

    const result = calculateStreaks(
      [
        { status: "sent", sent_at: TODAY },
        { status: "draft", sent_at: TODAY },
        { status: "sent", sent_at: null },
        { status: "sent", sent_at: "not-a-date" },
      ],
      windows,
      NOW,
    );

    expect(result.totalActiveDays).toBe(1);
    expect(result.currentStreak).toBe(1);
  });

  it("returns the same numbers on repeated calls", async () => {
    seedMessage();
    seedMessage({ sent_at: LAST_MONTH });

    const first = await readStreaks();
    const second = await readStreaks();

    expect(second).toMatchObject({
      currentStreak: first.currentStreak,
      longestStreak: first.longestStreak,
      activeDaysThisWeek: first.activeDaysThisWeek,
      activeDaysThisMonth: first.activeDaysThisMonth,
      totalActiveDays: first.totalActiveDays,
    });
  });
});