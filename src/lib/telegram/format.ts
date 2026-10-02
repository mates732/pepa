/**
 * Telegram message formatting.
 *
 * Pure functions, no I/O — so the exact text a notification produces is unit
 * testable without touching the Telegram API.
 *
 * Plain text on purpose: no parse_mode means no HTML/Markdown injection surface
 * from lead names and subjects.
 */

import { formatDate } from "@/lib/format";
import type { ActionNotification } from "@/lib/providers/types";
import type { TelegramInlineButton } from "@/lib/telegram/client";

export const OPEN_IN_PEPA_LABEL = "OPEN IN PEPA";

export interface FollowUpDueDetails {
  leadName: string | null;
  email: string;
  /** 1-based follow-up attempt number. */
  attempt: number;
  lastContactedAt: string | null;
  /** Absolute PEPA deep link carrying only an opaque token. */
  deepLink: string;
}

export const FOLLOW_UP_DUE_TITLE = "🔥 FOLLOW-UP DUE";

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