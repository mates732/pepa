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

/**
 * Notification surface only — deliberately never includes the subject or the
 * body of the email. Those live behind the authenticated PEPA deep link.
 */
export function formatFollowUpDueMessage(details: FollowUpDueDetails): string {
  const lines = [
    "🔥 FOLLOW-UP DUE",
    "",
    details.leadName?.trim() || details.email,
    "",
    `Follow-up #${details.attempt}`,
    `Last contact: ${formatDate(details.lastContactedAt)}`,
    "",
    details.email,
  ];
  return lines.join("\n");
}

export function followUpDueButtons(details: FollowUpDueDetails): TelegramInlineButton[][] {
  return [[{ text: OPEN_IN_PEPA_LABEL, url: details.deepLink }]];
}

export function formatPlainNotification(title: string, body: string): string {
  return `${title}\n\n${body}`;
}