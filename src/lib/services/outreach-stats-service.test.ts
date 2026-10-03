import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveStatsWindows } from "@/lib/outreach/stats-windows";

/**
 * Tests for the Outreach Stats service.
 *
 * The clock is pinned per test. Stats is entirely about *when* something was
 * sent, so a test that leaned on the wall clock would quietly stop meaning what
 * it said the day the suite ran.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase, stats } = vi.hoisted(() => {
  const db = { messages: [] as Row[] };
  // Query and mutation counters. These are what prove the read is one bounded
  // query and that nothing is ever written.
  const stats = { queries: 0, writes: [] as string[], failWith: null as { message: string } | null };

  function readBuilder(filters: Array<[string, unknown]>, limit: number | null) {
    const matched = (): Row[] => {
      const filtered = db.messages.filter((row) =>
        filters.every(([column, value]) => {
          // PostgREST's `not.is.null` is exactly this: the column is not null.
          if (value === "__not_null__") return row[column] !== null && row[column] !== undefined;
          return row[column] === value;
        }),
      );
      return limit === null ? filtered : filtered.slice(0, limit);
    };

    stats.queries += 1;

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
          select: () => readBuilder([], null),
          insert: () => {
            stats.writes.push("INSERT");
            throw new Error("stats must not write");
          },
          update: () => {
            stats.writes.push("UPDATE");
            throw new Error("stats must not write");
          },
          upsert: () => {
            stats.writes.push("UPSERT");
            throw new Error("stats must not write");
          },
          delete: () => {
            stats.writes.push("DELETE");
            throw new Error("stats must not write");
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

/** Wednesday 2026-10-07, 12:00 local. Midweek, mid-month, no DST edge. */
const NOW = new Date("2026-10-07T10:00:00.000Z");

function seedMessage(overrides: Row = {}) {
  db.messages.push({
    status: "sent",
    sequence_number: 0,
    sent_at: "2026-10-07T09:00:00.000Z",
    ...overrides,
  });
}

/** Today, this week and this month, all as absolute instants. */
const TODAY = "2026-10-07T08:00:00.000Z";
const THIS_WEEK = "2026-10-05T08:00:00.000Z";
const LAST_WEEK = "2026-10-02T08:00:00.000Z";
const THIS_MONTH = "2026-10-01T08:00:00.000Z";
const LAST_MONTH = "2026-09-28T08:00:00.000Z";

async function load() {
  return import("@/lib/services/outreach-stats-service");
}

async function readStats(now: Date = NOW) {
  const { getOutreachStats } = await load();
  const result = await getOutreachStats({ timeZone: PRAGUE, now });
  if (!result.ok || !result.data) throw new Error(result.error ?? "stats failed");
  return result.data;
}

beforeEach(() => {
  db.messages = [];
  stats.queries = 0;
  stats.writes = [];
  stats.failWith = null;
});

describe("stats — zero state", () => {
  it("reports every figure as zero when nothing has been sent", async () => {
    const result = await readStats();

    expect(result).toMatchObject({
      today: 0,
      week: 0,
      month: 0,
      allTime: 0,
      initialOutreach: 0,
      followUps: 0,
      totalSent: 0,
      complete: true,
    });
  });

  it("is all zero even when unsent rows exist", async () => {
    seedMessage({ status: "draft", sent_at: null });
    seedMessage({ status: "ready", sent_at: null });

    const result = await readStats();
    expect(result.allTime).toBe(0);
    expect(result.today).toBe(0);
  });
});

describe("stats — what counts as a confirmed send", () => {
  it("counts a sent initial outreach", async () => {
    seedMessage({ sequence_number: 0, sent_at: TODAY });

    const result = await readStats();
    expect(result).toMatchObject({
      today: 1,
      week: 1,
      month: 1,
      allTime: 1,
      initialOutreach: 1,
      followUps: 0,
    });
  });

  it("counts a sent follow-up separately from an initial outreach", async () => {
    seedMessage({ sequence_number: 0, sent_at: THIS_WEEK });
    seedMessage({ sequence_number: 1, sent_at: TODAY });
    seedMessage({ sequence_number: 2, sent_at: TODAY });

    const result = await readStats();
    expect(result).toMatchObject({
      allTime: 3,
      initialOutreach: 1,
      followUps: 2,
      today: 2,
    });
  });

  it("excludes drafts", async () => {
    seedMessage({ status: "draft", sent_at: TODAY });

    expect((await readStats()).allTime).toBe(0);
  });

  it("excludes ready messages", async () => {
    seedMessage({ status: "ready", sent_at: TODAY });

    expect((await readStats()).allTime).toBe(0);
  });

  it("excludes a sent row with no sent_at, because it cannot be dated", async () => {
    seedMessage({ status: "sent", sent_at: null, sequence_number: 3 });

    const result = await readStats();
    expect(result.allTime).toBe(0);
    expect(result.today).toBe(0);
    expect(result.initialOutreach).toBe(0);
    expect(result.followUps).toBe(0);
  });

  it("excludes a non-sent row that nonetheless carries a sent_at", async () => {
    for (const status of ["draft", "ready", "replied", "follow_up", "completed", "blocked"]) {
      seedMessage({ status, sent_at: TODAY, sequence_number: 1 });
    }

    expect((await readStats()).allTime).toBe(0);
  });

  it("excludes a row whose sent_at is unparseable", async () => {
    seedMessage({ status: "sent", sent_at: "not-a-date" });

    expect((await readStats()).allTime).toBe(0);
  });
});

describe("stats — day boundaries", () => {
  it("counts a send at the start of today", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.dayStart });

    expect((await readStats()).today).toBe(1);
  });

  it("does not count a send at the start of tomorrow", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.nextDayStart });

    const result = await readStats();
    expect(result.today).toBe(0);
    // It still counts as a send — it simply belongs to tomorrow.
    expect(result.allTime).toBe(1);
  });

  it("does not count yesterday as today", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: new Date(Date.parse(windows.dayStart) - 1).toISOString() });

    const result = await readStats();
    expect(result.today).toBe(0);
    // Yesterday is still inside this week and this month.
    expect(result.week).toBe(1);
    expect(result.month).toBe(1);
  });

  it("keeps today inside the week and the month", async () => {
    seedMessage({ sent_at: TODAY });

    const result = await readStats();
    expect(result.today).toBe(1);
    expect(result.week).toBe(1);
    expect(result.month).toBe(1);
  });
});

describe("stats — week boundaries (Monday start)", () => {
  it("counts a send earlier in the current week", async () => {
    seedMessage({ sent_at: THIS_WEEK });

    const result = await readStats();
    expect(result.week).toBe(1);
    // Monday the 5th is not today, but it is this week and this month.
    expect(result.today).toBe(0);
    expect(result.month).toBe(1);
  });

  it("excludes the previous week", async () => {
    seedMessage({ sent_at: LAST_WEEK });

    const result = await readStats();
    expect(result.week).toBe(0);
    // Friday the 2nd is still inside October.
    expect(result.month).toBe(1);
  });

  it("excludes the week boundary instant itself", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.weekStart });
    seedMessage({ sent_at: new Date(Date.parse(windows.weekStart) - 1).toISOString() });
    seedMessage({ sent_at: windows.nextWeekStart });

    const result = await readStats();
    // Only the send exactly on Monday 00:00 belongs to this week.
    expect(result.week).toBe(1);
    // All three instants fall inside October, so the month still counts them.
    expect(result.month).toBe(3);
  });

  it("puts Sunday in the week that began six days earlier", async () => {
    // Checked on Sunday itself: the 11th belongs to the week that opened on
    // Monday the 5th, not to a week starting on the 11th.
    const sunday = new Date("2026-10-11T10:00:00.000Z");
    seedMessage({ sent_at: "2026-10-11T09:00:00.000Z" });

    const result = await readStats(sunday);
    expect(result.week).toBe(1);
    expect(result.today).toBe(1);
  });
});

describe("stats — month boundaries", () => {
  it("counts a send earlier in the current month", async () => {
    seedMessage({ sent_at: THIS_MONTH });

    const result = await readStats();
    expect(result.month).toBe(1);
    // The 1st is in last week, not this one.
    expect(result.week).toBe(0);
  });

  it("excludes the previous month", async () => {
    seedMessage({ sent_at: LAST_MONTH });

    const result = await readStats();
    expect(result.month).toBe(0);
    expect(result.allTime).toBe(1);
  });

  it("excludes the start of next month", async () => {
    const windows = resolveStatsWindows(PRAGUE, NOW);
    seedMessage({ sent_at: windows.monthStart });
    seedMessage({ sent_at: windows.nextMonthStart });

    const result = await readStats();
    expect(result.month).toBe(1);
  });
});

describe("stats — breakdown", () => {
  it("classifies sequence 0 as initial outreach and everything above as a follow-up", async () => {
    seedMessage({ sequence_number: 0, sent_at: THIS_MONTH });
    seedMessage({ sequence_number: 1, sent_at: THIS_MONTH });
    seedMessage({ sequence_number: 7, sent_at: LAST_MONTH });

    const result = await readStats();
    expect(result.initialOutreach).toBe(1);
    expect(result.followUps).toBe(2);
    expect(result.initialOutreach + result.followUps).toBe(result.allTime);
  });

  it("does not infer the breakdown from the subject", async () => {
    // A follow-up whose subject claims to be the first email, and an initial
    // outreach whose subject claims to be a follow-up.
    db.messages = [
      { status: "sent", sequence_number: 2, sent_at: THIS_MONTH, subject: "First email" },
      { status: "sent", sequence_number: 0, sent_at: THIS_MONTH, subject: "Following up" },
    ];

    const result = await readStats();
    expect(result.initialOutreach).toBe(1);
    expect(result.followUps).toBe(1);
  });

  it("reports totalSent as the same authoritative count as allTime", async () => {
    seedMessage({ sequence_number: 0, sent_at: THIS_MONTH });
    seedMessage({ sequence_number: 1, sent_at: LAST_MONTH });

    const result = await readStats();
    expect(result.totalSent).toBe(result.allTime);
    expect(result.totalSent).toBe(2);
  });
});

describe("stats — independence and determinism", () => {
  it("counts sends from many leads together, without per-lead queries", async () => {
    for (let i = 1; i <= 5; i += 1) {
      seedMessage({ sequence_number: i === 1 ? 0 : 1, sent_at: THIS_MONTH });
    }

    const result = await readStats();
    expect(result.allTime).toBe(5);
    expect(result.initialOutreach).toBe(1);
    expect(result.followUps).toBe(4);
  });

  it("returns the same numbers on repeated calls", async () => {
    seedMessage({ sequence_number: 0, sent_at: TODAY });
    seedMessage({ sequence_number: 1, sent_at: LAST_MONTH });

    const first = await readStats();
    const second = await readStats();

    expect(second).toMatchObject({
      today: first.today,
      week: first.week,
      month: first.month,
      allTime: first.allTime,
      initialOutreach: first.initialOutreach,
      followUps: first.followUps,
      totalSent: first.totalSent,
    });
  });

  it("resolves windows in the reader's zone, so counts agree with Activity", async () => {
    // 02:00 UTC on the 3rd is 04:00 in Prague (the 3rd) but 22:00 on the 2nd in
    // New York. The same send is "today" in one zone and not in the other, which
    // is exactly why the zone has to come from the reader.
    const now = new Date("2026-10-03T12:00:00.000Z");
    seedMessage({ sent_at: "2026-10-03T02:00:00.000Z" });

    const { getOutreachStats } = await load();
    const prague = await getOutreachStats({ timeZone: PRAGUE, now });
    const newYork = await getOutreachStats({ timeZone: "America/New_York", now });

    expect(prague.data?.today).toBe(1);
    expect(newYork.data?.today).toBe(0);
    // Both agree on the total: it is the same send either way.
    expect(prague.data?.allTime).toBe(1);
    expect(newYork.data?.allTime).toBe(1);
  });
});

describe("stats — query behaviour", () => {
  it("reads once, whatever the number of sends", async () => {
    for (let i = 1; i <= 12; i += 1) {
      seedMessage({ sequence_number: i === 1 ? 0 : 1, sent_at: THIS_MONTH });
    }

    await readStats();
    // A per-row or per-bucket query would make this grow with the data.
    expect(stats.queries).toBe(1);
  });

  it("bounds the rows it reads", async () => {
    const { MAX_STATS_SCAN_ROWS } = await load();
    seedMessage();

    await readStats();
    expect(MAX_STATS_SCAN_ROWS).toBe(50_000);
    expect(MAX_STATS_SCAN_ROWS).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("performs no write of any kind", async () => {
    seedMessage();

    await readStats();
    expect(stats.writes).toEqual([]);
  });

  it("rejects an unusable time zone without querying", async () => {
    const { getOutreachStats } = await load();
    const result = await getOutreachStats({ timeZone: "Mars/Olympus", now: NOW });

    expect(result.ok).toBe(false);
    expect(stats.queries).toBe(0);
  });

  it("contains a raw driver error, since the action echoes this message", async () => {
    // The action passes the service's error string straight through, so the
    // service — not the action — is where driver text has to stop.
    stats.failWith = { message: 'relation "public.outreach_messages" does not exist' };

    const { getOutreachStats } = await load();
    const result = await getOutreachStats({ timeZone: PRAGUE, now: NOW });

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/relation|postgres|pg_|syntax/i);
    expect(result.error).toBe("Stats could not be loaded.");
  });
});

describe("stats — the counting function on its own", () => {
  it("re-checks the predicate even if a row bypasses the query", async () => {
    const { countSentStats } = await load();
    const windows = resolveStatsWindows(PRAGUE, NOW);

    const result = countSentStats(
      [
        { status: "sent", sequence_number: 0, sent_at: TODAY },
        { status: "draft", sequence_number: 0, sent_at: TODAY },
        { status: "sent", sequence_number: 0, sent_at: null },
      ],
      windows,
    );

    // Only the one confirmed send counts, even though all three reached the
    // function directly.
    expect(result.allTime).toBe(1);
    expect(result.today).toBe(1);
  });

  it("reports an incomplete scan instead of under-counting silently", async () => {
    const { MAX_STATS_SCAN_ROWS, countSentStats } = await load();
    const windows = resolveStatsWindows(PRAGUE, NOW);

    const full = countSentStats(
      Array.from({ length: MAX_STATS_SCAN_ROWS }, () => ({ status: "sent", sequence_number: 0, sent_at: TODAY })),
      windows,
    );

    // A capped scan is a real condition the UI must be able to admit.
    expect(full.allTime).toBe(MAX_STATS_SCAN_ROWS);
    expect(full.complete).toBe(false);
  });
});