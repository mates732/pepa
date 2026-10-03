/**
 * Streak arithmetic over calendar-day keys.
 *
 * Pure leaf module, like `stats-windows.ts`, `activity-days.ts` and
 * `gmail-compose.ts`: no I/O, no Supabase, no clock of its own. It takes the
 * unique calendar days that already contain a confirmed send and answers the
 * factual questions the Streaks surface asks. Everything here is testable
 * without a database and without a rendered number.
 *
 * CALENDAR DAYS, NOT ELAPSED HOURS
 *
 * Everything is computed on `YYYY-MM-DD` day keys produced by
 * `stats-windows.localDayKeyInZone`. That is deliberate. A streak is a
 * statement about *dates people sent outreach on*, so it must be decided by
 * calendar arithmetic. Two rules follow, and both are load-bearing:
 *
 *   * the day after a key is `shiftDayKey(key, +1)` — a calendar date, never
 *     `instant + 86 400 000`;
 *   * consecutive means "the next calendar date", never "24 hours later".
 *
 * A day that contains 23 or 25 real hours (a DST transition) is one key like
 * any other, so a streak across it is unbroken and a single send on it is a
 * single active day. Nothing here reads the wall clock: `todayKey` is an
 * argument, which is what lets the tests pin "today" exactly.
 *
 * DAYLIGHT SAVING AND OTHER ZONE ODDITIES
 *
 * Because the arithmetic never touches an instant, zone behaviour cannot leak
 * into it. The zone's influence stops at the boundary: it decides which key a
 * send belongs to (in `stats-windows`), and from there on this module compares
 * plain calendar dates. No offset is stored, no offset is assumed, and a zone
 * that skips a local midnight simply has no key for that date.
 *
 * RANGES ARE KEY RANGES
 *
 * `week` and `month` are resolved by the caller into the same `StatsWindows`
 * Phase 6 already resolved — Monday-to-Monday and first-of-month to first-of-
 * next-month — and are converted here into the *keys* of their two edges. The
 * window instants are never re-derived here, so Streaks and Stats cannot
 * disagree about which dates belong to the current week or month.
 */

export interface StreakMetrics {
  /** Consecutive active calendar days ending on today. 0 when today is inactive. */
  currentStreak: number;
  /** Longest run of consecutive active calendar days in the supplied history. */
  longestStreak: number;
  /** Unique active days inside the current week window. */
  activeDaysThisWeek: number;
  /** Unique active days inside the current month window. */
  activeDaysThisMonth: number;
  /** Unique active days across everything supplied. */
  totalActiveDays: number;
  /** Days in the resolved week window — 7 under the Monday-based rule. */
  daysInWeek: number;
  /** Days in the resolved month window: 28, 29, 30 or 31. */
  daysInMonth: number;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface StreakInput {
  /** Calendar days known to contain at least one confirmed send. Duplicates collapse. */
  dayKeys: Iterable<string>;
  /** The reader's current calendar day, `YYYY-MM-DD`. */
  todayKey: string;
  /** Key of the first day of the current week window, inclusive. */
  weekStartKey: string;
  /** Key of the first day *after* the current week, exclusive. */
  weekEndKey: string;
  /** Key of the first day of the current month, inclusive. */
  monthStartKey: string;
  /** Key of the first day of the next month, exclusive. */
  monthEndKey: string;
}

/**
 * Compute every streak figure from a set of active calendar days.
 *
 * Multiple sends on one day are already the caller's problem — they are
 * collapsed here by the set below, so five sends on one date can produce one
 * active day and never a five-day streak.
 */
export function computeStreakMetrics(input: StreakInput): StreakMetrics {
  const active = new Set<string>();
  for (const key of input.dayKeys) {
    // Defensive: a malformed key is dropped rather than silently shifted into a
    // neighbouring day, which is what a `Number("20-10-07")` fallback would do.
    if (typeof key === "string" && DAY_KEY.test(key)) active.add(key);
  }

  return {
    currentStreak: currentStreakFrom(active, input.todayKey),
    longestStreak: longestStreakFrom(active),
    activeDaysThisWeek: countWithin(active, input.weekStartKey, input.weekEndKey),
    activeDaysThisMonth: countWithin(active, input.monthStartKey, input.monthEndKey),
    totalActiveDays: active.size,
    daysInWeek: daysBetweenKeys(input.weekStartKey, input.weekEndKey),
    daysInMonth: daysBetweenKeys(input.monthStartKey, input.monthEndKey),
  };
}

/**
 * Consecutive active days ending **today**.
 *
 * Today has to be active. A streak that ended yesterday is yesterday's run, not
 * the current one: reporting it as current would be claiming an unbroken run
 * that today has already broken. So an inactive today is always 0, and the walk
 * only starts from today.
 *
 * Backward, one calendar date at a time, stopping at the first inactive day.
 */
export function currentStreakFrom(activeDays: Set<string>, todayKey: string): number {
  if (!DAY_KEY.test(todayKey)) return 0;
  if (!activeDays.has(todayKey)) return 0;

  let streak = 0;
  let cursor = todayKey;
  while (activeDays.has(cursor)) {
    streak += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  return streak;
}

/**
 * The longest run of consecutive active calendar days anywhere in the history.
 *
 * Keys are zero-padded, so sorting them lexically is sorting them
 * chronologically — no date parsing and no offset. Two neighbouring keys are
 * consecutive only when the later is exactly the next calendar date; anything
 * else is a new run, which is what makes a single inactive day break a streak.
 */
export function longestStreakFrom(activeDays: Set<string>): number {
  const sorted = [...activeDays].sort();
  let longest = 0;
  let run = 0;
  let previous: string | null = null;

  for (const key of sorted) {
    run = previous !== null && key === shiftDayKey(previous, 1) ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = key;
  }

  return longest;
}

/** Unique active days in the half-open key range `[start, end)`. */
function countWithin(activeDays: Set<string>, start: string, end: string): number {
  let count = 0;
  for (const key of activeDays) {
    if (key >= start && key < end) count += 1;
  }
  return count;
}

/**
 * Shift a plain calendar date by whole days.
 *
 * UTC is used purely as an arithmetic aid on a key that carries no time and no
 * zone, exactly as `stats-windows.shiftDate` does — so month and year rollover
 * is handled by `Date` and no daylight-saving rule can apply to a date with no
 * time of day.
 */
export function shiftDayKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Whole calendar days from `start` up to `end`, where `end` is the exclusive
 * edge. This is how the UI gets its honest denominator for "18 / 31" without
 * the browser re-deriving a month length of its own.
 *
 * Returns 0 when the range is not usable, so a caller can never render
 * "18 / 0".
 */
export function daysBetweenKeys(start: string, end: string): number {
  if (!DAY_KEY.test(start) || !DAY_KEY.test(end) || end <= start) return 0;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000,
  );
}