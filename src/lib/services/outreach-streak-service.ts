import "server-only";

import { computeStreakMetrics, type StreakMetrics } from "@/lib/outreach/streak-days";
import {
  localDayKeyInZone,
  resolveStatsWindows,
  type StatsWindows,
} from "@/lib/outreach/stats-windows";
import { MAX_STATS_SCAN_ROWS } from "@/lib/services/outreach-stats-service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { ServiceResult } from "@/lib/types";

/**
 * Outreach Streaks — a read-only, derived view of the *days* outreach went out.
 *
 * A streak is derived ONLY from recorded sends, under the same predicate Stats
 * uses:
 *
 *   status   = 'sent'
 *   sent_at IS NOT NULL
 *
 * Never from `leads.followup_count`, `leads.last_contacted_at`,
 * `leads.next_followup_at`, Activity's or Stats' UI state, or any scheduling
 * field. Those describe what the engine intends to do next, not what happened.
 *
 * AN ACTIVE DAY
 *
 * A calendar day containing at least one qualifying send. Several sends on one
 * day are still one active day — five messages on Monday is a Monday with
 * activity, not a five-day run. The counting therefore happens on calendar-day
 * keys and deduplicates before anything is measured, so a busy day can never
 * inflate a streak, a week count, or the total.
 *
 * WHAT THIS IS NOT
 *
 * This is an analytics surface. No XP, points, badges, levels, rewards, freezes
 * or motivational framing exists here or is planned: a streak is a count of
 * dates, and it is reported as one.
 *
 * DERIVED, NEVER STORED
 *
 * There is no streak table, no active-day table, no counter column, no
 * materialised view and no aggregation job. Everything is recomputed per read
 * from `outreach_messages`, which stays the single source of truth. No write of
 * any kind is reachable from this module.
 */

const SENT_STATUS = "sent";

/**
 * The scan bound is the one Stats already uses, imported rather than copied.
 *
 * Both readers scan the same table with the same predicate and the same limit,
 * so a second, drifting constant could make the two surfaces disagree about
 * which rows exist. Reusing the constant keeps one guard for one table.
 */
export { MAX_STATS_SCAN_ROWS };

/** The minimum a row needs to place a send on a calendar day. */
export interface StreakRow {
  status: string | null;
  sent_at: string | null;
}

export interface OutreachStreaks extends StreakMetrics {
  /**
   * False when the scan hit {@link MAX_STATS_SCAN_ROWS}, meaning these figures
   * cover the most recent recorded sends rather than every send ever stored.
   * A longest streak ending at the scan boundary may therefore continue into
   * history that was not loaded, and is reported as "based on available
   * history" rather than as a lifetime maximum.
   */
  complete: boolean;
  /**
   * Whether `currentStreak` is exact.
   *
   * The query reads newest first, so when the scan is capped the rows for today
   * are the first ones returned. If today's rows are not the whole returned set,
   * everything after them is older, and today's contiguous run is fully
   * covered: the current streak is exact even though the historical longest
   * streak is not. Only when the capped set is made entirely of today's sends is
   * the run in doubt, and this says so instead of implying certainty.
   */
  currentStreakComplete: boolean;
  /** The windows and zone every figure was resolved against, for tests and display. */
  windows: StatsWindows;
  generatedAt: string;
}

/**
 * Group confirmed sends into active calendar days and measure the streaks.
 *
 * Pure and exported, so every boundary rule can be tested without a database
 * and the counting can never drift from what the query found.
 *
 * `windows` is the caller's already-resolved Phase 6 window set. Reusing it is
 * what guarantees Streaks and Stats agree about which calendar dates belong to
 * the current week and month: both take their edges from the same six instants.
 */
export function calculateStreaks(rows: StreakRow[], windows: StatsWindows, now: Date): OutreachStreaks {
  const { timeZone } = windows;

  // One entry per active day; the count is only used to judge whether a capped
  // scan covered today, never to inflate a figure.
  const sendsPerDay = new Map<string, number>();

  for (const row of rows) {
    // Defensive re-check of the predicate, for the same reason Stats does it: a
    // row that reached this function by any other path must not slip into a
    // counter unsent or undated.
    if (row.status !== SENT_STATUS) continue;

    const sentAt = row.sent_at;
    if (!sentAt) continue;
    if (Number.isNaN(Date.parse(sentAt))) continue;

    const key = localDayKeyInZone(timeZone, sentAt);
    if (!key) continue;

    sendsPerDay.set(key, (sendsPerDay.get(key) ?? 0) + 1);
  }

  const todayKey = localDayKeyInZone(timeZone, now) ?? "";
  const capped = rows.length >= MAX_STATS_SCAN_ROWS;

  const metrics = computeStreakMetrics({
    dayKeys: sendsPerDay.keys(),
    todayKey,
    weekStartKey: localDayKeyInZone(timeZone, windows.weekStart) ?? "",
    weekEndKey: localDayKeyInZone(timeZone, windows.nextWeekStart) ?? "",
    monthStartKey: localDayKeyInZone(timeZone, windows.monthStart) ?? "",
    monthEndKey: localDayKeyInZone(timeZone, windows.nextMonthStart) ?? "",
  });

  // See `currentStreakComplete`. Today's rows come first in a newest-first
  // scan, so any row beyond them is older than today.
  const sendsToday = todayKey ? (sendsPerDay.get(todayKey) ?? 0) : 0;
  const currentStreakComplete = !capped || sendsToday < rows.length;

  return {
    ...metrics,
    complete: !capped,
    currentStreakComplete,
    windows,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Load the current streaks.
 *
 * One bounded query for two columns, newest first; every figure is derived
 * server-side from the returned rows. There is no per-day query to become an
 * N+1, no per-lead query, and nothing is written.
 *
 * The ordering is functional, not cosmetic: with a cap in play, reading newest
 * first keeps the days a current streak depends on inside the scan and keeps
 * `currentStreakComplete` truthful.
 *
 * `timeZone` is the reader's IANA calendar — where each day starts — and
 * nothing more. `now` is injectable for tests only; the action never accepts
 * it, so no caller can pin the streaks to a chosen day.
 */
export async function getOutreachStreaks(input: {
  timeZone: string;
  now?: Date;
}): Promise<ServiceResult<OutreachStreaks>> {
  let windows: StatsWindows;
  try {
    windows = resolveStatsWindows(input.timeZone, input.now ?? new Date());
  } catch {
    return { ok: false, data: null, error: "Streaks could not be resolved for this time zone." };
  }

  const { data, error } = await getSupabaseAdmin()
    .from("outreach_messages")
    .select("status, sent_at")
    .eq("status", SENT_STATUS)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(MAX_STATS_SCAN_ROWS);

  if (error) {
    // Never surface a raw driver error to the browser.
    return { ok: false, data: null, error: "Streaks could not be loaded." };
  }

  const rows = (data ?? []) as StreakRow[];

  return {
    ok: true,
    data: calculateStreaks(rows, windows, input.now ?? new Date()),
    error: null,
  };
}