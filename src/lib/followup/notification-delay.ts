/**
 * Configurable follow-up Telegram notification delay.
 *
 * Pure module — no I/O, no environment access. Everything about *when* a
 * notification becomes eligible, given a scheduling instant and a configured
 * delay, is decided here.
 *
 * The delay is an offset from the follow-up's DUE moment — the instant the
 * cadence says the email should go out (for follow-up #1: 4 business days after
 * the previous touchpoint). It is deliberately NOT an offset from the send:
 * the operator asked for a timer, so the bot writes when the follow-up comes
 * due, not when it was scheduled. A delay of 0 (the default) means "exactly on
 * time"; a positive one is a late reminder ("1 day" = a day after it came due).
 *
 * The email-due timestamp itself (`next_followup_at`) is computed by the cadence
 * module and never depends on this configuration.
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
 * Default delay: 0 — the notification fires the moment the follow-up becomes
 * due, which is the timer the operator asked for. A positive value shifts the
 * notification later; it is never negative, so a notification cannot arrive
 * before the follow-up it announces.
 */
export const DEFAULT_DELAY: DelayConfig = {
  value: 0,
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
 * Compute the notification due timestamp from an anchor instant and a delay.
 *
 * `anchorAt` is the follow-up's due moment — the cadence-based
 * `next_followup_at` computed by `markFollowUpSent()` — so the default zero
 * delay notifies exactly when the email should go out.
 */
export function computeNotificationDueAt(
  anchorAt: Date | string,
  config: DelayConfig,
): Date {
  const base = typeof anchorAt === "string" ? new Date(anchorAt) : anchorAt;
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
