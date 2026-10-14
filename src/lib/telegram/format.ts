/**
 * Telegram message formatting.
 *
 * Pure functions, no I/O — so the exact text a notification produces is unit
 * testable without touching the Telegram API.
 *
 * Plain text on purpose: no parse_mode means no HTML/Markdown injection surface
 * from lead names and subjects.
 */

import { formatDate, formatDateTime } from "@/lib/format";
import type { ActionNotification } from "@/lib/providers/types";
import type { TelegramInlineButton } from "@/lib/telegram/client";

export const OPEN_IN_PEPA_LABEL = "OPEN IN PEPA";

export interface FollowUpDueDetails {
  leadName: string | null;
  email: string;
  /** 1-based follow-up attempt number. */
  attempt: number;
  lastContactedAt: string | null;
  /**
   * When this follow-up became (or becomes) due — the schedule the engine
   * computed from the initial send. Shown so the operator can tell an overdue
   * follow-up from one that only just came due.
   */
  dueAt: string | null;
  /** Absolute PEPA deep link carrying only an opaque token. */
  deepLink: string;
}

export const FOLLOW_UP_DUE_TITLE = "🔥 FOLLOW-UP DUE";

export const STREAK_REMINDER_TITLE = "⏰ STREAK REMINDER";

/**
 * The 19:00 streak reminder — the plain-text surface, split the same way as
 * {@link formatFollowUpNotification} so the two can never drift in shape.
 *
 * Notification surface only: it names the run at risk and the deadline, and
 * nothing about any specific lead, subject or body. Those live behind the
 * authenticated PEPA link, which for a reminder is the app itself — the
 * operator picks what to send next.
 */
export interface StreakReminderDetails {
  /** Length of the consecutive run today would continue. 0 when none is at risk. */
  streakDays: number;
  /** Absolute PEPA URL the action button opens. */
  appUrl: string;
}

export function formatStreakReminderNotification(details: StreakReminderDetails): {
  title: string;
  body: string;
} {
  const run =
    details.streakDays >= 2
      ? `Yesterday kept a ${details.streakDays}-day streak alive. It ends at midnight.`
      : details.streakDays === 1
        ? "Yesterday started a streak. It ends at midnight."
        : "No streak is running right now.";

  return {
    title: STREAK_REMINDER_TITLE,
    body: [
      "No outreach recorded as sent today.",
      "",
      run,
      "",
      // "keep" only makes sense when there is something to keep.
      details.streakDays >= 1 ? "Send one now to keep it." : "Send one now to start a new run.",
    ].join("\n"),
  };
}

/** The reminder as a channel-agnostic ActionNotification, like the follow-up due one. */
export function toStreakReminderNotification(details: StreakReminderDetails): ActionNotification {
  const { title, body } = formatStreakReminderNotification(details);
  return {
    title,
    body,
    actionLabel: OPEN_IN_PEPA_LABEL,
    actionUrl: details.appUrl,
  };
}

/**
 * The same surface as `formatFollowUpDueMessage`, split into the channel-agnostic
 * title/body pair. Rendering it back through `formatPlainNotification` reproduces
 * `formatFollowUpDueMessage` byte for byte — the engine and the in-app trigger
 * can therefore never drift apart.
 *
 * Notification surface only — deliberately never includes the subject or the
 * body of the email. Those live behind the authenticated PEPA deep link.
 */
export function formatFollowUpNotification(details: FollowUpDueDetails): {
  title: string;
  body: string;
} {
  return {
    title: FOLLOW_UP_DUE_TITLE,
    body: [
      details.leadName?.trim() || details.email,
      "",
      `Follow-up #${details.attempt}`,
      `Due: ${formatDateTime(details.dueAt)}`,
      `Last contact: ${formatDate(details.lastContactedAt)}`,
      "",
      details.email,
    ].join("\n"),
  };
}

/**
 * The follow-up engine mints the deep link, so it emits an ActionNotification
 * and the channel only renders it — no Telegram concept leaks upward.
 */
export function toActionNotification(details: FollowUpDueDetails): ActionNotification {
  const { title, body } = formatFollowUpNotification(details);
  return {
    title,
    body,
    actionLabel: OPEN_IN_PEPA_LABEL,
    actionUrl: details.deepLink,
  };
}

export function formatFollowUpDueMessage(details: FollowUpDueDetails): string {
  const { title, body } = formatFollowUpNotification(details);
  return formatPlainNotification(title, body);
}

export function followUpDueButtons(details: FollowUpDueDetails): TelegramInlineButton[][] {
  return [[{ text: OPEN_IN_PEPA_LABEL, url: details.deepLink }]];
}

export function formatPlainNotification(title: string, body: string): string {
  return `${title}\n\n${body}`;
}