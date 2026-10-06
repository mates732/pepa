/**
 * Follow-up cadence — the single source of truth.
 *
 * Delay is expressed as BUSINESS DAYS after the PREVIOUS touchpoint, so
 * nextFollowUpDueAt() is all the engine needs to schedule attempt N+1.
 * Saturdays and Sundays never count, and every weekday is decided in
 * Europe/Prague — never in UTC and never in the browser's local zone.
 *
 * Pure module, no I/O, no environment access: everything about *when* a
 * follow-up is due is decided here and nowhere else. Cadence overrides
 * are parsed by cadence-config.ts (server-only), which reads
 * PEPA_FOLLOWUP_CADENCE and passes the result into these functions.
 */

export const FOLLOW_UP_CADENCE_DAYS = [4, 7, 10] as const;

/** Timezone in which follow-up days are counted and due days decided. */
export const FOLLOW_UP_TIMEZONE = "Europe/Prague";

/** Highest follow-up number the engine will ever notify (default cadence). */
export const MAX_FOLLOW_UPS = FOLLOW_UP_CADENCE_DAYS.length;

/**
 * 1-based follow-up number -> delay in business days after the previous
 * touchpoint. `from` is always the previous email's actual `sentAt`,
 * never the lead's `createdAt`.
 */
export function delayForFollowUp(
  followUpNumber: number,
  cadence: readonly number[] = FOLLOW_UP_CADENCE_DAYS,
): number | null {
  if (followUpNumber < 1) return null;
  return cadence[followUpNumber - 1] ?? null;
}

export function isWithinCadence(
  followUpNumber: number,
  cadence: readonly number[] = FOLLOW_UP_CADENCE_DAYS,
): boolean {
  return followUpNumber >= 1 && followUpNumber <= cadence.length;
}

/**
 * True when `date` is a working day (Monday–Friday) in Europe/Prague.
 *
 * Deliberately timezone-aware: Friday 22:00 UTC is already Saturday
 * 00:00 in Prague and is NOT a business day. Extendable later with
 * Czech public holidays; ignoring weekends is the minimum rule.
 */
export function isBusinessDay(date: Date): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: FOLLOW_UP_TIMEZONE,
    weekday: "short",
  }).format(date);
  return (
    weekday === "Mon" ||
    weekday === "Tue" ||
    weekday === "Wed" ||
    weekday === "Thu" ||
    weekday === "Fri"
  );
}

/**
 * `businessDays` working days after `from`, skipping Prague weekends.
 *
 * Steps one calendar day at a time and keeps the instant, so the
 * result is exact across the DST transition: the Prague wall-clock
 * hour may shift by one hour when the offset changes, but the calendar
 * day — the only thing the scheduler compares — is always right.
 *
 * Example: Friday + 2 business days = Tuesday (Sat/Sun skipped).
 */
export function addBusinessDays(from: Date, businessDays: number): Date {
  const result = new Date(from);
  let added = 0;
  while (added < businessDays) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (isBusinessDay(result)) added += 1;
  }
  return result;
}

/**
 * When follow-up #followUpNumber becomes due.
 *
 * `from` is the previous touchpoint's actual send time (the initial
 * send, or the previous follow-up's `sentAt` — never `createdAt`).
 * Returns null past the cadence: after the last follow-up PEPA stops
 * chasing.
 */
export function nextFollowUpDueAt(
  from: Date | string,
  followUpNumber: number,
  cadence: readonly number[] = FOLLOW_UP_CADENCE_DAYS,
): Date | null {
  const base = typeof from === "string" ? new Date(from) : from;
  const delay = delayForFollowUp(followUpNumber, cadence);
  if (delay === null || Number.isNaN(base.getTime())) return null;
  return addBusinessDays(base, delay);
}

/**
 * Parse a cadence override such as "2,4,7". Returns null when the value
 * is empty or any entry is not a positive integer, so a typo can never
 * silently produce a nonsense schedule.
 */
export function parseFollowUpCadence(text: string): number[] | null {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  const values = parts.map(Number);
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    return null;
  }
  return values;
}

/** Absolute UTC instant. Never uses browser-local time. */
export function toUtcIso(date: Date): string {
  return date.toISOString();
}

export function isDue(dueAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  const value = Date.parse(dueAt);
  if (Number.isNaN(value)) return false;
  return value <= now.getTime();
}
