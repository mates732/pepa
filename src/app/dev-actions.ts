"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { buildDeepLink } from "@/lib/config/base-url";
import { createFollowUpToken } from "@/lib/services/action-token-service";
import { getLead } from "@/lib/services/lead-service";
import { listOutreachHistory } from "@/lib/services/outreach-service";
import { getTelegramProvider } from "@/lib/providers/notifications";
import type { Lead } from "@/lib/types";

/**
 * Development trigger for the Telegram channel, so `sendFollowUpDue()` can be
 * exercised end-to-end without waiting for the follow-up scheduler.
 *
 * Safety, in order:
 *   1. `requireAuthenticatedUser()` — an unauthenticated caller gets nothing;
 *   2. production is HARD-DISABLED — see `devToolsEnabled()` below;
 *   3. Telegram must be configured.
 *
 * There is no unauthenticated endpoint anywhere in PEPA.
 */

export type TestTelegramResult =
  | { ok: true; messageId: string | null; deepLink: string; lead: string }
  | { ok: false; error: string };

/**
 * Whether the dev affordances are available.
 *
 * Production returns FALSE unconditionally. `PEPA_ENABLE_DEV_TOOLS` is
 * deliberately NOT honoured there: this action sends real Telegram messages and
 * mints real `action_tokens` rows, it has no rate limit of its own, and a
 * mis-set environment flag must not be able to switch it on in a deployed
 * environment.
 *
 * Outside production the tools are always available. That is not a change: the
 * previous `NODE_ENV !== "production" || PEPA_ENABLE_DEV_TOOLS === "true"`
 * expression was already always true there, because its left operand was
 * already true. The flag never changed the outcome in any environment, and is
 * retained in `.env.example` and the deployment runbook purely as documentation
 * of intent.
 */
export async function devToolsEnabled(): Promise<boolean> {
  if (process.env.NODE_ENV === "production") return false;
  return true;
}

/**
 * Sends a real notification for a real lead, so the Telegram → button → PEPA
 * deep-link path can be checked by hand.
 */
export async function sendTestTelegramNotification(
  leadId?: string,
): Promise<TestTelegramResult> {
  await requireAuthenticatedUser();

  if (!(await devToolsEnabled())) {
    return {
      ok: false,
      error: "Dev tools are disabled (set PEPA_ENABLE_DEV_TOOLS=true to enable).",
    };
  }

  const provider = getTelegramProvider();
  if (!provider.isConfigured()) {
    return { ok: false, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)." };
  }

  const lead = leadId ? await loadLead(leadId) : await pickAnyLead();
  if (!lead) {
    return {
      ok: false,
      error: "No lead found. Save a draft in the dashboard first, then run this again.",
    };
  }

  try {
    const result = await provider.sendFollowUpDue({ lead, attempt: lead.followup_count + 1 });
    const preview = await createFollowUpToken({ leadId: lead.id });

    return {
      ok: true,
      messageId: result.providerMessageId,
      deepLink:
        preview.ok && preview.data
          ? await buildDeepLink(preview.data.token)
          : "https://<your-pepa-host>/followup/<token>",
      lead: lead.email,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Telegram delivery failed." };
  }
}

async function loadLead(leadId: string): Promise<Lead | null> {
  const result = await getLead(leadId);
  return result.ok ? result.data : null;
}

async function pickAnyLead(): Promise<Lead | null> {
  const result = await listOutreachHistory({ limit: 1 });
  if (!result.ok || !result.data?.length) return null;
  return result.data[0];
}