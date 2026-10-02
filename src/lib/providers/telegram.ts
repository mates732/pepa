/**
 * Telegram provider — implements `NotificationService`.
 *
 * This is the ONLY module that knows Telegram exists. Follow-up logic depends on
 * `NotificationService`, so adding email or push later means registering another
 * provider, not rewriting anything above it.
 *
 *   FollowUpService (V2)
 *        ↓
 *   NotificationService   ← the abstraction
 *        ↓
 *   TelegramProvider      ← this file
 *        ↓
 *   Telegram Bot API      ← dumb HTTP wrapper in src/lib/telegram/client.ts
 */

import "server-only";

import { buildDeepLink } from "@/lib/config/base-url";
import { createFollowUpToken } from "@/lib/services/action-token-service";
import type { Lead } from "@/lib/types";
import {
  followUpDueButtons,
  formatFollowUpDueMessage,
  type FollowUpDueDetails,
} from "@/lib/telegram/format";
import {
  getTelegramConfig,
  normalizeChatId,
  sendTelegramMessage,
  type TelegramApiResult,
} from "@/lib/telegram/client";
import type { Notification, NotificationService, SendResult } from "@/lib/providers/types";

export class TelegramProvider implements NotificationService {
  readonly id = "telegram";

  isConfigured(): boolean {
    return getTelegramConfig().configured;
  }

  /** `NotificationService.send` — the generic channel contract. */
  async send(notification: Notification): Promise<void> {
    const result = await this.sendNotification(notification.title, notification.body);
    if (!result.ok) {
      throw new Error(`Telegram delivery failed: ${result.description ?? "unknown error"}`);
    }
  }

  /** Named entry point for the richer message body. */
  async sendNotification(title: string, body: string): Promise<TelegramApiResult> {
    return sendTelegramMessage({ chatId: normalizeChatId(process.env.TELEGRAM_CHAT_ID), text: `${title}\n\n${body}` });
  }

  /**
   * The notification the future follow-up engine will emit.
   *
   * Mints a fresh, opaque, short-lived deep-link token for the lead and attaches
   * it as a single button. No subject, no body, no lead id — the URL is an
   * unguessable reference, and opening it still requires a PEPA session.
   */
  async sendFollowUpDue(input: { lead: Lead; attempt: number }): Promise<SendResult> {
    const config = getTelegramConfig();
    if (!config.configured) {
      throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).");
    }

    // Minting requires a PEPA session (V2's cron will need a documented
    // server-to-server path here — deliberately not built yet).
    const minted = await createFollowUpToken({ leadId: input.lead.id });
    if (!minted.ok || !minted.data) {
      throw new Error(minted.error ?? "Could not mint a follow-up deep link.");
    }

    const details: FollowUpDueDetails = {
      leadName: input.lead.company_name ?? input.lead.contact_name,
      email: input.lead.email,
      attempt: input.attempt,
      lastContactedAt: input.lead.last_contacted_at,
      deepLink: await buildDeepLink(minted.data.token),
    };

    const result = await sendTelegramMessage({
      chatId: normalizeChatId(config.chatId),
      text: formatFollowUpDueMessage(details),
      buttons: followUpDueButtons(details),
    });

    if (!result.ok) {
      throw new Error(`Telegram delivery failed: ${result.description ?? "unknown error"}`);
    }

    return {
      provider: "telegram",
      providerMessageId: result.messageId === null ? null : String(result.messageId),
      sentAt: new Date().toISOString(),
    };
  }
}

/**
 * Authorization boundary: only the configured chat may interact with PEPA.
 * Comparison is exact after normalisation, so " 12345" matches but 123456 does not.
 */
export function isAuthorizedChat(chatId: string | number | null | undefined): boolean {
  const expected = normalizeChatId(process.env.TELEGRAM_CHAT_ID);
  if (!expected) return false;
  return normalizeChatId(chatId) === expected;
}