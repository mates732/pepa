/**
 * Thin Telegram Bot API client.
 *
 * Deliberately dumb: it knows HTTP and nothing about PEPA. All PEPA semantics
 * live in `src/lib/providers/telegram.ts`, and no Telegram concept should leak
 * into the follow-up services.
 *
 * Security rules for this module:
 *  * The bot token is read server-side only and never returned or logged.
 *  * Errors are replaced with the Telegram `description` field only — the token
 *    appears in Telegram URLs, so request errors are scrubbed before surfacing.
 */

import "server-only";

export interface TelegramInlineButton {
  text: string;
  url: string;
}

export interface TelegramMessagePayload {
  chatId: string;
  text: string;
  /** URL-only buttons. No callback_data is used: PEPA never puts lead data in Telegram payloads. */
  buttons?: TelegramInlineButton[][];
  /** Suppresses the noisy "new message" notification on phones. */
  disableNotification?: boolean;
}

export interface TelegramApiResult {
  ok: boolean;
  messageId: number | null;
  description: string | null;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 8_000;

function scrub(value: string): string {
  return value
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/[0-9]{8,}:[A-Za-z0-9_-]{20,}/g, "<redacted>");
}

/** Chat ids are compared as trimmed strings so "-1001234567890" and ints both work. */
export function normalizeChatId(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function getTelegramConfig(): {
  token: string | null;
  chatId: string | null;
  webhookSecret: string | null;
  configured: boolean;
} {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const chatId = normalizeChatId(process.env.TELEGRAM_CHAT_ID);
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
  return { token, chatId: chatId || null, webhookSecret, configured: Boolean(token && chatId) };
}

async function callApi(
  method: string,
  payload: Record<string, unknown>,
): Promise<TelegramApiResult> {
  const { token } = getTelegramConfig();
  if (!token) {
    return { ok: false, messageId: null, description: "TELEGRAM_BOT_TOKEN is not configured." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });

    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number }; description?: string }
      | null;

    if (!response.ok || !body?.ok) {
      return {
        ok: false,
        messageId: null,
        description: scrub(body?.description ?? `HTTP ${response.status}`),
      };
    }

    return { ok: true, messageId: body.result?.message_id ?? null, description: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return { ok: false, messageId: null, description: scrub(reason) };
  } finally {
    clearTimeout(timer);
  }
}

/** Used by the webhook to acknowledge a callback tap without changing state. */
export async function answerCallbackQuery(callbackId: string, text?: string): Promise<boolean> {
  const result = await callApi("answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text, show_alert: false } : {}),
  });
  return result.ok;
}

export async function sendTelegramMessage(
  message: TelegramMessagePayload,
): Promise<TelegramApiResult> {
  const { chatId } = getTelegramConfig();
  if (!chatId) {
    return { ok: false, messageId: null, description: "TELEGRAM_CHAT_ID is not configured." };
  }

  const replyMarkup = message.buttons?.length
    ? { inline_keyboard: message.buttons.map((row) => row.map((button) => ({ ...button }))) }
    : undefined;

  const result = await callApi("sendMessage", {
    chat_id: chatId,
    text: message.text,
    disable_web_page_preview: true,
    ...(message.disableNotification ? { disable_notification: true } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

  return result;
}