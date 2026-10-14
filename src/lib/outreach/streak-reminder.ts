import { currentStreakFrom, shiftDayKey } from "./streak-days";

/**
 * The 19:00 streak reminder — everything about *whether* to write, decided here.
 *
 * Pure leaf module, like `streak-days.ts` and `stats-windows.ts`: no I/O, no
 * Supabase, no clock of its own. The service resolves the calendar day keys and
 * the local hour, and this module answers the only question the reminder
 * engine asks: is there an unbroken run of days with a recorded send that today
 * is about to break, and is it late enough in the day to say so?
 *
 * THE RULE
 *
 *   remind when:  yesterday had a send
 *             AND today has none yet
 *             AND the local hour is >= STREAK_REMINDER_HOUR (19:00)
 *
 * All three halves are load-bearing:
 *
 *   * "yesterday had a send" — a run only exists if yesterday continued one.
 *     A reminder on a day that already broke nothing is noise, not protection,
 *     so an inactive yesterday is silent.
 *   * "today has none" — one send during the day is all it takes, so the day
 *     the operator already sent is never reminded.
 *   * ">= 19:00" — the operator asked for the deadline to be 19:00. Before it,
 *     there is still time to send and nothing to warn about; from 19:00 the
 *     day is running out, and the reminder fires once for the whole evening.
 *
 * DAY KEYS, NOT ELAPSED HOURS
 *
 * "Yesterday" and "today" are calendar dates from
 * `stats-windows.localDayKeyInZone`, shifted by `streak-days.shiftDayKey` — so
 * the reminder can never be thrown off by a daylight-saving transition, exactly
 * like every other calendar fact in this module group.
 *
 * The hour is wall-clock time in the SAME zone the day keys come from, so a
 * serverless runtime in UTC cannot make the reminder fire at 17:00 UTC on a
 * winter evening (18:00 in Prague) or miss it at 19:00 UTC in summer.
 */

/** The local hour from which the reminder becomes eligible. */
export const STREAK_REMINDER_HOUR = 19;

export interface StreakReminderInput {
  /** Calendar day keys known to contain at least one confirmed send. */
  dayKeys: Iterable<string>;
  /** The operator's current calendar day, `YYYY-MM-DD`. */
  todayKey: string;
  /** The current local hour, 0–23, in the zone `todayKey` was derived from. */
  hour: number;
  /** Override for the deadline hour; defaults to {@link STREAK_REMINDER_HOUR}. */
  reminderHour?: number;
}

export interface StreakReminderDecision {
  /**
   * True when a reminder should be sent now. Implies `atRisk`.
   *
   * False is not a verdict about the streak — only about this moment: a run at
   * risk before 19:00 is still `atRisk` and stays silent until the deadline.
   */
  due: boolean;
  /**
   * True when yesterday had a recorded send and today has none. The run is
   * still savable — one send today continues it.
   */
  atRisk: boolean;
  /**
   * Length of the consecutive run that today would continue: the run ending
   * yesterday. 0 when nothing is at risk.
   */
  streakDays: number;
  /** The calendar day the decision is about. */
  dayKey: string;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Decide whether the streak reminder is due.
 *
 * The streak length comes from `currentStreakFrom` anchored on *yesterday*,
 * the same walk the current-streak figure uses anchored on today — so the
 * number in the notification is computed by the one function that already
 * defines what a streak is, and cannot drift from what the card shows.
 */
export function decideStreakReminder(input: StreakReminderInput): StreakReminderDecision {
  const active = new Set<string>();
  for (const key of input.dayKeys) {
    if (typeof key === "string" && DAY_KEY.test(key)) active.add(key);
  }

  if (!DAY_KEY.test(input.todayKey)) {
    // A malformed day key means the caller could not resolve the calendar at
    // all. Silence is the only honest answer — never a guessed reminder.
    return { due: false, atRisk: false, streakDays: 0, dayKey: "" };
  }

  const sentToday = active.has(input.todayKey);
  const yesterdayKey = shiftDayKey(input.todayKey, -1);
  const sentYesterday = active.has(yesterdayKey);

  const atRisk = sentYesterday && !sentToday;
  const streakDays = atRisk ? currentStreakFrom(active, yesterdayKey) : 0;

  const deadline = input.reminderHour ?? STREAK_REMINDER_HOUR;
  const hour = Number.isFinite(input.hour) ? input.hour : -1;
  const due = atRisk && hour >= deadline;

  return { due, atRisk, streakDays, dayKey: input.todayKey };
}
