/**
 * Configurable follow-up Telegram notification delay.
 *
 * Pure module — no I/O, no environment access. Everything about *when* a
 * notification becomes eligible, given a scheduling instant and a configured
 * delay, is decided here.
 *
 * The delay is added to the scheduling instant (the time `markFollowUpSent()`
 * runs, i.e. the initial email's `sentAt`) to produce `notification_due_at`.
 * This is independent of `next_followup_at`, which stays the cadence-based
 * email-due timestamp.
 *
 * Units: seconds, minutes, hours, days. Days are calendar days (not business
 * days) — the notification is a prompt, not a follow-up in the cadence sense.
 */

export type DelayUnit = "seconds" | "minutes" | "hours" | "days";

export interface DelayConfig {
  value: number;
  unit: DelayUnit;
}

export interface ComputedDue {
  notificationDueAt: Date;
  nextFollowUpAt: Date | null;
}

/**
 * Default delay: 3 minutes. Matches the behaviour the operator originally asked
 * for and is short enough that the notification arrives while the follow-up is
 * still fresh, without being instantaneous (which would race the cron).
 */
export const DEFAULT_DELAY: DelayConfig = {
  value: 3,
  unit: "minutes",
};

/**
 * Valid units. `days` are calendar days; the notification prompt is not a
 * follow-up in the cadence sense, so business-day rules do not apply.
 */
export const DELAY_UNITS: readonly DelayUnit[] = [
  "seconds",
  "minutes",
  "hours",
  "days",
];

const UNIT_TO_MS: Record<DelayUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/**
 * Validate a delay config.
 *
 * Value must be a non-negative finite integer. Negative values are rejected
 * because they would make the notification due before it was scheduled, which
 * is nonsensical.
 */
export function validateDelayConfig(config: {
  value: number;
  unit: string;
}): config is DelayConfig {
  if (!DELAY_UNITS.includes(config.unit as DelayUnit)) return false;
  if (!Number.isInteger(config.value)) return false;
  if (config.value < 0) return false;
  if (!Number.isFinite(config.value)) return false;
  return true;
}

/**
 * Compute the notification due timestamp from a scheduling instant and a delay.
 *
 * `scheduledAt` is the moment the follow-up was scheduled — in the current
 * model, the initial email's `sentAt` from `markFollowUpSent()`.
 */
export function computeNotificationDueAt(
  scheduledAt: Date | string,
  config: DelayConfig,
): Date {
  const base = typeof scheduledAt === "string" ? new Date(scheduledAt) : scheduledAt;
  const ms = config.value * UNIT_TO_MS[config.unit];
  return new Date(base.getTime() + ms);
}

/**
 * Compute the notification due instant, formatted as UTC ISO.
 */
export function computeNotificationDueAtIso(
  scheduledAt: Date | string,
  config: DelayConfig,
): string {
  return computeNotificationDueAt(scheduledAt, config).toISOString();
}

/**
 * Decide whether a notification is eligible now.
 *
 * When `notificationDueAt` is NULL (legacy pre-migration lead, or a lead whose
 * notification has not been scheduled yet), fall back to `nextFollowUpAt` so
 * the existing behaviour is preserved: the notification fires when the email is
 * due.
 */
export function isNotificationDue(
  notificationDueAt: string | null,
  nextFollowUpAt: string | null,
  now: Date = new Date(),
): boolean {
  const notificationTime = notificationDueAt ? Date.parse(notificationDueAt) : Number.NaN;
  if (Number.isFinite(notificationTime)) {
    return notificationTime <= now.getTime();
  }
  // Legacy fallback: notification due = email due.
  if (!nextFollowUpAt) return false;
  return Date.parse(nextFollowUpAt) <= now.getTime();
}
