/**
 * Webhook authorization helpers.
 *
 * Pure functions so the security rules can be unit tested without a live bot:
 *   - Telegram's `secret_token` header (`X-Telegram-Bot-Api-Secret-Token`)
 *   - "only the owner's chat may talk to PEPA"
 *   - defensive parsing of an untrusted update body
 */

import { constantTimeEquals } from "@/lib/auth/token";
import { normalizeChatId } from "@/lib/telegram/client";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Telegram's own mechanism: the secret is set once via `setWebhook` and echoed
 * on every delivery. Fails closed when the secret is not configured.
 */
export function isValidWebhookSecret(
  received: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || !received) return false;
  return constantTimeEquals(received, expected);
}

export interface TelegramChatRef {
  id: string | number;
  type?: string;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: TelegramChatRef;
    from?: TelegramChatRef;
  };
  edited_message?: {
    message_id?: number;
    text?: string;
    chat?: TelegramChatRef;
    from?: TelegramChatRef;
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: TelegramChatRef;
    message?: { chat?: TelegramChatRef };
  };
}

/** Parse an untrusted body. Returns null rather than throwing. */
export function parseTelegramUpdate(raw: string | null | undefined): TelegramUpdate | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as TelegramUpdate;
  } catch {
    return null;
  }
}

/** The chat an update originated from, whether it is a message or a callback. */
export function chatIdFromUpdate(update: TelegramUpdate): string | null {
  const candidate =
    update.message?.chat ??
    update.edited_message?.chat ??
    update.callback_query?.message?.chat ??
    update.callback_query?.from;

  const id = candidate?.id;
  return id === undefined || id === null ? null : normalizeChatId(id);
}

/**
 * The single authorized chat. A mismatch is indistinguishable from "unknown
 * update" to the caller — no PEPA data is ever returned either way.
 */
export function isAuthorizedChatId(chatId: string | null, expected: string | null): boolean {
  if (!expected || !chatId) return false;
  // Normalise both sides: Telegram may deliver a number, a negative group id
  // or a string with padding, and all three must compare equal to the config.
  return normalizeChatId(chatId) === normalizeChatId(expected);
}