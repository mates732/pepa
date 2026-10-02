import "server-only";

import { TelegramProvider } from "./telegram";
import { getNotificationService, registerNotificationService } from "./registry";

/**
 * Module-scope registration so the Telegram channel is discoverable through
 * `getNotificationService()` without any caller importing Telegram directly.
 *
 * Registration is unconditional but `isConfigured()` stays false until
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are present, so nothing breaks locally.
 */
const telegram = new TelegramProvider();
registerNotificationService(telegram);

export function getTelegramProvider(): TelegramProvider {
  return telegram;
}

/** Convenience accessor for the abstract channel used by follow-up logic. */
export function getNotificationChannel() {
  return getNotificationService("telegram") ?? getNotificationService();
}