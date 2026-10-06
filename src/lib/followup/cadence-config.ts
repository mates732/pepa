import "server-only";

import { FOLLOW_UP_CADENCE_DAYS, parseFollowUpCadence } from "./cadence";

/**
 * Server-side cadence configuration.
 *
 * The default cadence lives in cadence.ts, a pure module that client
 * components import — so environment access must not happen there.
 * This module is the only place that reads PEPA_FOLLOWUP_CADENCE.
 *
 * Format: comma-separated business-day delays, e.g. "2,4,7" means
 * follow-up #1 is due 2 business days after the previous email was
 * actually sent, #2 after 4, #3 after 7. Saturdays and Sundays never
 * count; days are decided in Europe/Prague (see cadence.ts).
 *
 * An unset or unparseable value falls back to the default cadence
 * rather than crashing the scheduler.
 */
export function getFollowUpCadence(): number[] {
  const raw = process.env.PEPA_FOLLOWUP_CADENCE;
  if (!raw) return [...FOLLOW_UP_CADENCE_DAYS];
  return parseFollowUpCadence(raw) ?? [...FOLLOW_UP_CADENCE_DAYS];
}
