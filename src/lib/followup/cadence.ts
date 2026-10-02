/**
 * Follow-up cadence — the single source of truth.
 *
 * Delay is expressed as "days after the PREVIOUS touchpoint", so
 * nextFollowUpDueAt() is all the engine needs to schedule attempt N+1.
 *
 * Pure module, no I/O, no environment access: everything about *when* a
 * follow-up is due is decided here and nowhere else.
 */

export const FOLLOW_UP_CADENCE_DAYS = [4, 7, 10] as const;

/** Highest follow-up number the engine will ever notify. */
export const MAX_FOLLOW_UPS = FOLLOW_UP_CADENCE_DAYS.length;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 1-based follow-up number -> delay after the previous touchpoint. */
export function delayForFollowUp(followUpNumber: number): number | null {
  if (followUpNumber < 1) return null;
  return FOLLOW_UP_CADENCE_DAYS[followUpNumber - 1] ?? null;
}

export function isWithinCadence(followUpNumber: number): boolean {
  return followUpNumber >= 1 && followUpNumber <= MAX_FOLLOW_UPS;
}

/**
 * When follow-up #followUpNumber becomes due.
 *
 * `from` is the previous touchpoint (initial send, or the previous follow-up).
 * Returns null past the cadence: after follow-up #3 PEPA stops chasing.
 */
export function nextFollowUpDueAt(from: Date | string, followUpNumber: number): Date | null {
  const base = typeof from === "string" ? new Date(from) : from;
  const delay = delayForFollowUp(followUpNumber);
  if (delay === null || Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + delay * DAY_MS);
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