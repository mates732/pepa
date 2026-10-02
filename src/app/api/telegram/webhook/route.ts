import { NextResponse, type NextRequest } from "next/server";

import { getTelegramConfig, answerCallbackQuery } from "@/lib/telegram/client";
import {
  chatIdFromUpdate,
  isAuthorizedChatId,
  isValidWebhookSecret,
  parseTelegramUpdate,
  TELEGRAM_SECRET_HEADER,
} from "@/lib/telegram/webhook-auth";

/**
 * Telegram webhook — inbound half of the Telegram integration.
 *
 * Security model, in the order it is enforced:
 *   1. `X-Telegram-Bot-Api-Secret-Token` must match TELEGRAM_WEBHOOK_SECRET.
 *   2. The update must come from TELEGRAM_CHAT_ID.
 * Anything else is answered with a plain 200 and no information whatsoever —
 * Telegram retries non-2xx responses, and a distinguishable error would leak
 * whether a chat is the owner.
 *
 * This route is NOT part of the PEPA session model: Telegram is a server peer,
 * not a browser. It never reads or mutates lead data, so it cannot bypass the
 * PEPA authentication that guards `/`, `/followup/*` and every server action.
 *
 * It also performs no long-running work. Follow-up generation is a V2 concern
 * driven by `next_followup_at`, not by an inbound webhook.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ok(): NextResponse {
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = getTelegramConfig();

  // 1. Shared-secret header. Fails closed when unset.
  if (!isValidWebhookSecret(request.headers.get(TELEGRAM_SECRET_HEADER), config.webhookSecret)) {
    return ok();
  }

  const update = parseTelegramUpdate(await request.text().catch(() => null));
  if (!update) return ok();

  // 2. Owner-only. Unknown chats are indistinguishable from junk updates.
  if (!isAuthorizedChatId(chatIdFromUpdate(update), config.chatId)) {
    return ok();
  }

  const callback = update.callback_query;
  if (callback) {
    // Callback payloads carry no lead data, so there is nothing to resolve yet.
    // This is the extension point for future inline (non-URL) buttons.
    if (callback.id) {
      void answerCallbackQuery(callback.id).catch(() => false);
    }
    return ok();
  }

  // Commands and unrelated update types are acknowledged and ignored. The bot
  // is a notification surface; it does not accept instructions.
  return ok();
}

/** Telegram never calls GET; answering keeps probes from leaking a 405 detail. */
export function GET(): NextResponse {
  return ok();
}