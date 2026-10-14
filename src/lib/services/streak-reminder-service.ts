import "server-only";

import { FOLLOW_UP_TIMEZONE } from "@/lib/followup/cadence";
import { getBaseUrl } from "@/lib/config/base-url";
import { getNotificationChannel } from "@/lib/providers/notifications";
import type { ActionNotification } from "@/lib/providers/types";
import {
  localDayKeyInZone,
  localHourInZone,
  resolveStatsWindows,
  type StatsWindows,
} from "@/lib/outreach/stats-windows";
import { shiftDayKey } from "@/lib/outreach/streak-days";
import { decideStreakReminder } from "@/lib/outreach/streak-reminder";
import { MAX_STATS_SCAN_ROWS } from "@/lib/services/outreach-stats-service";
import { toStreakReminderNotification } from "@/lib/telegram/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { ServiceResult } from "@/lib/types";

/**
 * The 19:00 streak reminder engine.
 *
 * WHAT THE OPERATOR ASKED FOR
 *
 *   "When I don't send any outreach by 19:00, Telegram writes that I should
 *   send one, so I don't lose the streak."
 *
 * So: after a day with no recorded send, at 19:00 local, one Telegram message.
 * Not a per-lead notification — there is no lead involved. The unit is the
 * operator's own calendar day, and the counters that feed the decision are the
 * ones Stats and Streaks already use.
 *
 * DERIVED, NEVER STORED — EXCEPT THE FACT OF THE REMINDER
 *
 * The streak itself stays derived (see `outreach-streak-service.ts`). The one
 * thing stored is the reminder's own delivery, in `streak_reminders`, keyed by
 * calendar day: a cron that runs several times an evening — and twice a day
 * across the daylight-saving change, see the route's schedules — must deliver
 * exactly one message per day, and a day must never be reminded twice.
 *
 * CLAIM, SEND, RECORD — in that order, the same shape the follow-up engine
 * uses. A claim that cannot be delivered is released so the next run retries;
 * a Telegram failure is never recorded as a reminder.
 *
 * THE ZONE
 *
 * The day keys and the hour are resolved in ONE zone, and it is the same
 * Europe/Prague calendar the follow-up cadence already uses
 * (`FOLLOW_UP_TIMEZONE`). The scheduler runs on UTC infrastructure, so a
 * wall-clock deadline has to be read in the operator's calendar or it silently
 * moves by an hour twice a year.
 */

/** How long a `claimed` row is honoured before another run may take it over. */
const REMINDER_CLAIM_LEASE_MS = 30 * 60 * 1000;

const REMINDER_DAY_STATUS = {
  claimed: "claimed",
  sent: "sent",
} as const;

/** The slice of a notification channel the reminder engine needs. */
export interface StreakReminderNotifier {
  sendActionNotification(notification: ActionNotification): Promise<void>;
}

export interface StreakReminderState {
  /** True when the reminder should be sent now. Implies {@link atRisk}. */
  due: boolean;
  /** Yesterday had a recorded send, today has none — the run is still savable. */
  atRisk: boolean;
  /** Length of the consecutive run today would continue. */
  streakDays: number;
  /** The operator's calendar day, `YYYY-MM-DD`, in {@link timeZone}. */
  todayKey: string;
  /** The calendar day before it. */
  yesterdayKey: string;
  /** Confirmed sends recorded today (same predicate Stats uses). */
  sentToday: number;
  /** The local hour the decision was taken at, 0–23. */
  hour: number;
  timeZone: string;
  /** The windows every figure was resolved against, for display and tests. */
  windows: StatsWindows;
  /** False when the scan hit {@link MAX_STATS_SCAN_ROWS}. */
  complete: boolean;
  generatedAt: string;
}

export interface StreakReminderOutcome {
  /** True when the state could be resolved at all. */
  checked: boolean;
  /** True when the Telegram message was delivered by this run. */
  reminded: boolean;
  /** This calendar day was already reminded. */
  skippedAlreadyReminded: boolean;
  /** A streak was at risk but the 19:00 deadline had not arrived. */
  skippedNotDue: boolean;
  /** Nothing was at risk: today already has a send, or yesterday had none. */
  skippedNothingAtRisk: boolean;
  /** The reminder could not be delivered; the claim was released for a retry. */
  failed: boolean;
}

/** The minimum a row needs to place a send on a calendar day. */
interface StreakRow {
  status: string | null;
  sent_at: string | null;
}

/**
 * Resolve whether the streak reminder is due.
 *
 * One bounded query, newest first — the same scan the streaks surface runs —
 * grouped into calendar days. `now` is injectable for tests only; the cron
 * never accepts it, so no caller can pin the reminder to a chosen evening.
 *
 * `timeZone` defaults to the canonical calendar the cadence already uses, so a
 * cron request cannot remind in a zone of its own choosing.
 */
export async function getStreakReminderState(input: {
  timeZone?: string;
  now?: Date;
} = {}): Promise<ServiceResult<StreakReminderState>> {
  const timeZone = input.timeZone ?? FOLLOW_UP_TIMEZONE;
  const now = input.now ?? new Date();

  let windows: StatsWindows;
  try {
    windows = resolveStatsWindows(timeZone, now);
  } catch {
    return { ok: false, data: null, error: "The streak reminder could not be resolved for this time zone." };
  }

  const { data, error } = await getSupabaseAdmin()
    .from("outreach_messages")
    .select("status, sent_at")
    .eq("status", "sent")
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(MAX_STATS_SCAN_ROWS);

  if (error) {
    return { ok: false, data: null, error: "The streak reminder could not be loaded." };
  }

  const rows = (data ?? []) as StreakRow[];

  const dayKeys = new Set<string>();
  let sentToday = 0;
  for (const row of rows) {
    // Defensive re-check of the predicate, for the same reason Stats and
    // Streaks do it: a row that reached this function by any other path must
    // not count as a send.
    if (row.status !== "sent") continue;
    const sentAt = row.sent_at;
    if (!sentAt || Number.isNaN(Date.parse(sentAt))) continue;

    const key = localDayKeyInZone(timeZone, sentAt);
    if (key) dayKeys.add(key);

    if (Date.parse(sentAt) >= Date.parse(windows.dayStart) && Date.parse(sentAt) < Date.parse(windows.nextDayStart)) {
      sentToday += 1;
    }
  }

  const todayKey = localDayKeyInZone(timeZone, now) ?? "";
  const hour = localHourInZone(timeZone, now) ?? -1;
  const decision = decideStreakReminder({ dayKeys, todayKey, hour });

  return {
    ok: true,
    error: null,
    data: {
      due: decision.due,
      atRisk: decision.atRisk,
      streakDays: decision.streakDays,
      todayKey: decision.dayKey,
      yesterdayKey: decision.dayKey ? shiftDayKey(decision.dayKey, -1) : "",
      sentToday,
      hour,
      timeZone,
      windows,
      complete: rows.length < MAX_STATS_SCAN_ROWS,
      generatedAt: now.toISOString(),
    },
  };
}

type ReminderClaim = "claimed" | "already_reminded" | "busy";

/**
 * Take ownership of today's reminder.
 *
 * The PRIMARY KEY on `day_key` is the idempotency: concurrent runs race and
 * exactly one wins, decided by Postgres rather than by a JS mutex.
 */
async function claimStreakReminder(dayKey: string, streakDays: number, now: Date): Promise<ReminderClaim> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("streak_reminders")
    .insert({
      day_key: dayKey,
      status: REMINDER_DAY_STATUS.claimed,
      streak_days: streakDays,
      claimed_at: now.toISOString(),
    });

  if (!error) return "claimed";
  if (error.code === "23505") return resolveExistingReminder(dayKey, now);
  throw new Error(error.message);
}

/** Decide what to do about a day that already has a ledger row. */
async function resolveExistingReminder(dayKey: string, now: Date): Promise<ReminderClaim> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("streak_reminders")
    .select("status, claimed_at")
    .eq("day_key", dayKey)
    .maybeSingle();

  if (error) throw new Error(error.message);
  const row = data as { status: string; claimed_at: string } | null;
  if (!row) return "busy";
  if (row.status === REMINDER_DAY_STATUS.sent) return "already_reminded";

  // An unexpired lease belongs to another run: leave it alone.
  const claimedAt = Date.parse(row.claimed_at);
  if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < REMINDER_CLAIM_LEASE_MS) {
    return "busy";
  }

  // Expired lease (crashed worker): compare-and-set on exactly the row read.
  const { data: taken, error: takeoverError } = await supabase
    .from("streak_reminders")
    .update({ status: REMINDER_DAY_STATUS.claimed, claimed_at: now.toISOString() })
    .eq("day_key", dayKey)
    .eq("status", REMINDER_DAY_STATUS.claimed)
    .eq("claimed_at", row.claimed_at)
    .select("day_key")
    .maybeSingle();

  if (takeoverError) throw new Error(takeoverError.message);
  return taken ? "claimed" : "busy";
}

/** Record the delivery. */
async function markReminderSent(dayKey: string, streakDays: number, now: Date): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("streak_reminders")
    .update({ status: REMINDER_DAY_STATUS.sent, streak_days: streakDays, sent_at: now.toISOString() })
    .eq("day_key", dayKey);

  if (error) throw new Error(error.message);
}

/**
 * Release a claim after a failed send, so the day stays reminded-able and a
 * later run retries. A Telegram failure is never recorded as a reminder.
 */
async function releaseReminder(dayKey: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("streak_reminders")
    .delete()
    .eq("day_key", dayKey)
    .eq("status", REMINDER_DAY_STATUS.claimed);

  if (error) throw new Error(error.message);
}

/**
 * Run the 19:00 streak reminder: at most one Telegram message per calendar
 * day, delivered only when a run is genuinely at risk.
 *
 * Returns counts, never content: no lead, no subject, no body, no URL crosses
 * this boundary back to the caller.
 */
export async function processStreakReminder(options: {
  /** Injected by tests; defaults to the registered notification channel. */
  notifier?: StreakReminderNotifier;
  now?: Date;
  timeZone?: string;
} = {}): Promise<StreakReminderOutcome> {
  const outcome: StreakReminderOutcome = {
    checked: false,
    reminded: false,
    skippedAlreadyReminded: false,
    skippedNotDue: false,
    skippedNothingAtRisk: false,
    failed: false,
  };

  const state = await getStreakReminderState({ timeZone: options.timeZone, now: options.now });
  if (!state.ok || !state.data) {
    // A state that cannot be resolved is a failure of the run, not a silent
    // "nothing to do" — the cron reports it.
    outcome.failed = true;
    return outcome;
  }

  outcome.checked = true;
  const now = options.now ?? new Date();

  if (!state.data.atRisk) {
    outcome.skippedNothingAtRisk = true;
    return outcome;
  }
  if (!state.data.due) {
    outcome.skippedNotDue = true;
    return outcome;
  }

  const channel = options.notifier ?? getNotificationChannel();
  const send = channel?.sendActionNotification?.bind(channel);
  if (!send) {
    outcome.failed = true;
    return outcome;
  }

  // Claim before building the message: a duplicate insert is what stops a
  // second run in the same evening from delivering the same reminder.
  let claim: ReminderClaim;
  try {
    claim = await claimStreakReminder(state.data.todayKey, state.data.streakDays, now);
  } catch {
    outcome.failed = true;
    return outcome;
  }

  if (claim === "already_reminded") {
    outcome.skippedAlreadyReminded = true;
    return outcome;
  }
  if (claim === "busy") {
    outcome.skippedAlreadyReminded = true;
    return outcome;
  }

  let delivered = false;
  try {
    // A reminder needs no token: it opens the app, where the day's counters and
    // the drafts to send are one tap away. `getBaseUrl` fails closed without
    // PEPA_BASE_URL in production, which is the honest outcome — better a
    // retryable failure than a link to a guessed origin.
    const appUrl = `${await getBaseUrl()}/`;
    const notification = toStreakReminderNotification({
      streakDays: state.data.streakDays,
      appUrl,
    });

    await send(notification);
    delivered = true;

    await markReminderSent(state.data.todayKey, state.data.streakDays, now);
    outcome.reminded = true;
  } catch {
    outcome.failed = true;
    if (!delivered) {
      // Never sent: release immediately so a later run retries today.
      await releaseReminder(state.data.todayKey).catch(() => undefined);
    }
    // If it WAS sent but bookkeeping failed, the claim is left alone: the lease
    // expires and a later run reclaims it, which would re-send the reminder —
    // the same trade the follow-up engine makes, and it is the safer one.
  }

  return outcome;
}
