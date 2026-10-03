/**
 * Calendar windows for Outreach Stats.
 *
 * Pure leaf module, like `activity-days.ts` and `gmail-compose.ts`: no I/O, no
 * Supabase, no clock of its own unless one is passed in. Every boundary rule the
 * stats surface depends on lives here, so each one can be tested directly rather
 * than inferred from a rendered number.
 *
 * WHY A TIME ZONE IS AN INPUT
 *
 * Stats counts are computed on the server, but "today" is a property of the
 * reader's calendar, not of the server's. A serverless runtime is typically UTC,
 * so counting UTC days here would quietly disagree with Activity, which groups
 * by the reader's local day — and the two surfaces would report different
 * numbers for the same sends.
 *
 * So the browser states *which calendar it is reading in* and this module
 * derives every boundary from that. The division of labour is deliberate:
 *
 *   * the client may name a zone (`Intl.DateTimeFormat().resolvedOptions()
 *     .timeZone`) — and nothing else;
 *   * the server decides where today starts, where the week starts and where the
 *     month starts, and does every count against the database.
 *
 * A client that lies about its zone can only mis-bucket a real send into an
 * adjacent day. It cannot invent a send, change a count, or widen a window to
 * cover arbitrary history, because the arithmetic and the row selection both
 * live server-side. Naming the zone is strictly less authority than the old
 * alternative of silently counting in the server's zone and disagreeing with
 * the rest of the UI.
 *
 * TIMEZONE
 *
 * The application has no global timezone architecture, and this phase does not
 * add one. Storage stays absolute UTC (`followup/cadence.ts`); the reader's
 * calendar is the display convention Phase 5 already established. This is not a
 * claim about Prague local time, and no fixed offset is assumed anywhere — the
 * offset is resolved per instant, so daylight-saving transitions are handled
 * rather than ignored.
 */

export interface StatsWindows {
  /** The zone these boundaries were resolved in. */
  timeZone: string;
  /** Start of the current local day, inclusive. */
  dayStart: string;
  /** Start of the next local day, exclusive. */
  nextDayStart: string;
  /** Monday 00:00 local, inclusive. */
  weekStart: string;
  /** The following Monday 00:00 local, exclusive. */
  nextWeekStart: string;
  /** First day of the current local month, 00:00, inclusive. */
  monthStart: string;
  /** First day of the next local month, 00:00, exclusive. */
  nextMonthStart: string;
}

/**
 * Reject anything that is not a usable IANA zone name.
 *
 * `new Intl.DateTimeFormat` throws `RangeError` on a bad zone, which is the
 * cheapest correct validation available without a dependency.
 */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string") return false;
  // An IANA identifier is short and has no path separators. This bound exists so
  // a hostile string cannot reach the formatter at all.
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock fields of `instant` as seen in `timeZone`. */
function localParts(timeZone: string, instant: Date): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") fields[part.type] = part.value;
  }

  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    // `h23` keeps midnight at 0. With `hour12: false` some runtimes emit "24"
    // for midnight, which would silently shift a whole day.
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}

/**
 * How far `timeZone` is ahead of UTC at `instant`, in milliseconds.
 *
 * Positive east of Greenwich (Prague, +1/+2), negative west (New York).
 */
function zoneOffsetMs(timeZone: string, instant: Date): number {
  const parts = localParts(timeZone, instant);
  // Seconds precision: an instant with milliseconds would otherwise fold its own
  // sub-second remainder into what is meant to be a pure zone offset.
  const floored = Math.floor(instant.getTime() / 1000) * 1000;
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asIfUtc - floored;
}

/**
 * The UTC instant of local midnight on the local date `year-month-day`.
 *
 * The offset that applies at local midnight is not always the offset that
 * applies at the naive UTC guess for that date, so it is resolved once and
 * re-checked after correction. Two passes are enough: the correction moves by
 * at most one offset step, and the second read is taken at the corrected
 * instant.
 *
 * Where a zone genuinely skips midnight on a DST spring-forward day, this
 * resolves to the first instant that does exist on that local date — the day's
 * real beginning, never the previous day.
 */
function startOfLocalDay(timeZone: string, year: number, month: number, day: number): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  const offset = zoneOffsetMs(timeZone, new Date(naive));
  let instant = naive - offset;

  const corrected = zoneOffsetMs(timeZone, new Date(instant));
  if (corrected !== offset) instant = naive - corrected;

  return new Date(instant);
}

/** Days since Sunday for a plain `YYYY-MM-DD`, via UTC to dodge DST entirely. */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Resolve every window Stats counts against, for the calendar containing `now`.
 *
 * Definitions, fixed here so there is exactly one of each:
 *
 *   day    — local midnight to the next local midnight.
 *   week   — Monday 00:00 local to the following Monday 00:00 local. Monday is
 *            the choice because no ISO/locale week rule exists in this
 *            repository; a configurable week start is a user setting and out of
 *            scope here.
 *   month  — the first of the local month at 00:00 to the first of the next one.
 *            A calendar month, deliberately not a rolling 30 days.
 *
 * All six are returned as ISO instants. Counters compare against these as a
 * half-open interval, `[start, nextStart)`, so a message landing exactly on a
 * boundary belongs to exactly one window and can never be double-counted.
 */
export function resolveStatsWindows(timeZone: string, now: Date = new Date()): StatsWindows {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError("Unknown time zone.");
  }

  const { year, month, day } = localParts(timeZone, now);

  // Day. Date.UTC normalises the overflow, so day + 1 is the next local date.
  const dayStart = startOfLocalDay(timeZone, year, month, day);
  const nextDayStart = startOfLocalDay(timeZone, ...shiftDate(year, month, day, 1));

  // Week. Monday-based: shift back by (weekday + 6) % 7 so Sunday maps to 6 and
  // Monday to 0. The arithmetic runs on UTC dates purely as a calendar aid, then
  // converts back through the zone.
  const backToMonday = (dayOfWeek(year, month, day) + 6) % 7;
  const monday = shiftDate(year, month, day, -backToMonday);
  const weekStart = startOfLocalDay(timeZone, ...monday);
  const nextWeekStart = startOfLocalDay(timeZone, ...shiftDate(...monday, 7));

  // Month. Month 13 normalises to January of the next year.
  const monthStart = startOfLocalDay(timeZone, year, month, 1);
  const nextMonth =
    month === 12
      ? ([year + 1, 1, 1] as DateArgs)
      : ([year, month + 1, 1] as DateArgs);
  const nextMonthStart = startOfLocalDay(timeZone, ...nextMonth);

  return {
    timeZone,
    dayStart: dayStart.toISOString(),
    nextDayStart: nextDayStart.toISOString(),
    weekStart: weekStart.toISOString(),
    nextWeekStart: nextWeekStart.toISOString(),
    monthStart: monthStart.toISOString(),
    nextMonthStart: nextMonthStart.toISOString(),
  };
}

type DateArgs = [year: number, month: number, day: number];

/** Shift a plain calendar date by whole days, normalising month/year overflow. */
function shiftDate(year: number, month: number, day: number, days: number): DateArgs {
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
}

/** `[start, end)` — a half-open window, so boundaries are never double-counted. */
export function isWithin(sentAt: string, start: string, end: string): boolean {
  const value = Date.parse(sentAt);
  if (Number.isNaN(value)) return false;
  return value >= Date.parse(start) && value < Date.parse(end);
}