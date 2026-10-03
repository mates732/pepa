import "server-only";

import { isWithin, resolveStatsWindows, type StatsWindows } from "@/lib/outreach/stats-windows";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { ServiceResult } from "@/lib/types";

/**
 * Outreach Stats — a read-only, derived view of confirmed sends.
 *
 * A send counts only when BOTH hold:
 *
 *   status   = 'sent'   — PEPA recorded this as a send.
 *   sent_at IS NOT NULL — and the instant it happened is on record.
 *
 * Both halves matter. A row at `status = 'sent'` with a NULL `sent_at` is an
 * anomaly — there is no moment to place it in a window — so counting it would
 * inflate every period with a send nobody can date. A row with a `sent_at` but
 * some other status is not a confirmed send at all.
 *
 * Never derived from `leads.followup_count`, `leads.last_contacted_at`,
 * `leads.next_followup_at`, Activity's UI state, or any client-side counter.
 * Those are scheduling fields: they say what the engine intends to do next, not
 * what went out. Every number here comes from `outreach_messages` and is
 * recomputed per request — nothing is cached, counted in the browser, or
 * stored.
 *
 * Stats and Activity read the same rows with the same predicate, so they cannot
 * disagree: any message Activity shows for a period is in the matching count.
 */

const SENT_STATUS = "sent";

/**
 * Upper bound on rows scanned for one stats load.
 *
 * Stats reads a projection (`sequence_number`, `sent_at`) of confirmed sends and
 * counts it on the server, so the browser never receives message history — only
 * seven numbers. This cap exists so that read can never grow without limit. It
 * is a guard, not an expected condition: the table is small, and hitting it is
 * reported honestly through `complete` rather than silently under-counting.
 */
export const MAX_STATS_SCAN_ROWS = 50_000;

/** The minimum a row needs to be classified. Deliberately not the full message. */
interface CountableRow {
  status: string | null;
  sequence_number: number | null;
  sent_at: string | null;
}

export interface OutreachStats {
  /** Confirmed sends inside the current local day. */
  today: number;
  /** Confirmed sends from Monday 00:00 local. */
  week: number;
  /** Confirmed sends from the first of the current local month. */
  month: number;
  /** Every confirmed send on record. */
  allTime: number;
  /** Confirmed sends at `sequence_number = 0`. */
  initialOutreach: number;
  /** Confirmed sends at `sequence_number > 0`. */
  followUps: number;
  /** Same authoritative count as {@link OutreachStats.allTime}, by definition. */
  totalSent: number;
  /**
   * False when the scan hit {@link MAX_STATS_SCAN_ROWS}, meaning the counts cover
   * a capped window rather than the whole table. Surfaced so the UI can admit it
   * instead of presenting a partial total as complete.
   */
  complete: boolean;
  /** The windows these counts were resolved against, for display and tests. */
  windows: StatsWindows;
  generatedAt: string;
}

/**
 * Classify confirmed sends into every reported figure.
 *
 * Pure and exported, so the boundary rules can be tested without a database and
 * the window arithmetic can never drift from the counting.
 *
 * Breakdown is by `sequence_number` alone: 0 is the initial outreach, anything
 * above it is a follow-up. Subject, body and `followup_count` are not consulted
 * — they describe what was written, not where the message sits in the
 * conversation.
 */
export function countSentStats(rows: CountableRow[], windows: StatsWindows): OutreachStats {
  let today = 0;
  let week = 0;
  let month = 0;
  let allTime = 0;
  let initialOutreach = 0;
  let followUps = 0;

  for (const row of rows) {
    // Defensive re-check of the predicate. The query already applies both
    // conditions; re-applying them here means a row that reached this function
    // through any future path cannot slip into a counter unsent or undated.
    if (row.status !== SENT_STATUS) continue;

    const sentAt = row.sent_at;
    if (!sentAt) continue;
    // `Number.isNaN`, never `=== Number.NaN`: NaN is not equal to itself, so
    // the `===` form silently never matches and an unparseable timestamp would
    // sail through as a real send.
    if (Number.isNaN(Date.parse(sentAt))) continue;

    allTime += 1;
    if (Number(row.sequence_number ?? 0) === 0) initialOutreach += 1;
    else followUps += 1;

    if (isWithin(sentAt, windows.dayStart, windows.nextDayStart)) today += 1;
    if (isWithin(sentAt, windows.weekStart, windows.nextWeekStart)) week += 1;
    if (isWithin(sentAt, windows.monthStart, windows.nextMonthStart)) month += 1;
  }

  return {
    today,
    week,
    month,
    allTime,
    initialOutreach,
    followUps,
    // Not a second source of truth: the same count, named for the breakdown.
    totalSent: allTime,
    complete: rows.length < MAX_STATS_SCAN_ROWS,
    windows,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Load the current stats.
 *
 * One bounded query for two columns; every count is then derived server-side.
 * There is no per-row query to become an N+1, and nothing is written.
 *
 * `timeZone` is the reader's IANA calendar, not a filter over data: it decides
 * where each window starts. `now` is injectable for tests only — the action
 * never accepts it from the client, so no caller can pin Stats to a chosen day.
 */
export async function getOutreachStats(input: {
  timeZone: string;
  now?: Date;
}): Promise<ServiceResult<OutreachStats>> {
  let windows: StatsWindows;
  try {
    windows = resolveStatsWindows(input.timeZone, input.now ?? new Date());
  } catch {
    return { ok: false, data: null, error: "Stats could not be resolved for this time zone." };
  }

  const { data, error } = await getSupabaseAdmin()
    .from("outreach_messages")
    .select("status, sequence_number, sent_at")
    .eq("status", SENT_STATUS)
    .not("sent_at", "is", null)
    .limit(MAX_STATS_SCAN_ROWS);

  if (error) {
    // Never surface a raw driver error to the browser.
    return { ok: false, data: null, error: "Stats could not be loaded." };
  }

  const rows = (data ?? []) as CountableRow[];

  return { ok: true, data: countSentStats(rows, windows), error: null };
}