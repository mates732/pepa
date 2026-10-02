import "server-only";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import {
  DEFAULT_ACTION_TOKEN_TTL_MS,
  expiresAt,
  generateActionToken,
  hashActionToken,
  isActionTokenFormat,
  isExpired,
  type ActionTokenPurpose,
} from "@/lib/deep-link/tokens";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Lead, OutreachMessage, ServiceResult } from "@/lib/types";

export interface ResolvedActionTarget {
  lead: Lead;
  /** Null when the token was minted without a specific message. */
  outreach: OutreachMessage | null;
  expiresAt: string;
}

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at";

function fail(error: string): ServiceResult<never> {
  return { ok: false, data: null, error };
}

/**
 * Mint a follow-up deep link on behalf of the operator in the browser.
 * Requires a PEPA session.
 */
export async function createFollowUpToken(input: {
  leadId: string;
  outreachId?: string | null;
  ttlMs?: number;
}): Promise<ServiceResult<{ token: string; expiresAt: string; id: string }>> {
  await requireAuthenticatedUser();
  return mintFollowUpToken(input);
}

/**
 * Core minting routine, without a session requirement.
 *
 * Server-to-server callers (the follow-up cron) authenticate with their own
 * credential — Vercel's CRON_SECRET — so they legitimately have no PEPA cookie.
 * Reaching this function still requires the service-role client, which is only
 * reachable from `server-only` modules.
 */
export async function mintFollowUpToken(input: {
  leadId: string;
  outreachId?: string | null;
  ttlMs?: number;
}): Promise<ServiceResult<{ token: string; expiresAt: string; id: string }>> {
  if (!input.leadId) return fail("A lead is required to mint a follow-up link.");

  const supabase = getSupabaseAdmin();
  const { count, error: leadError } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("id", input.leadId);

  if (leadError) return fail(leadError.message);
  if (!count) return fail("Lead not found.");

  const rawToken = generateActionToken();
  const ttl = input.ttlMs ?? DEFAULT_ACTION_TOKEN_TTL_MS;
  const expiry = expiresAt(Date.now(), ttl);

  const { data, error } = await supabase
    .from("action_tokens")
    .insert({
      token_hash: hashActionToken(rawToken),
      purpose: "followup_composer",
      lead_id: input.leadId,
      outreach_id: input.outreachId ?? null,
      expires_at: expiry.toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (error) return fail(error.message);

  return {
    ok: true,
    error: null,
    data: { token: rawToken, expiresAt: expiry.toISOString(), id: (data as { id: string }).id },
  };
}

/**
 * Resolve a raw token to its lead.
 *
 * Validates, in order: format, digest, existence, purpose, expiry. Every
 * failure returns the same message, so a caller cannot tell "no such token"
 * from "expired token" from "wrong purpose".
 *
 * Deliberately NOT single-use: within its TTL the link stays re-openable so a
 * phone can refresh or re-tap. First use is stamped in `used_at`.
 */
export async function resolveActionToken(
  rawToken: string | null | undefined,
  purpose: ActionTokenPurpose,
): Promise<ServiceResult<ResolvedActionTarget>> {
  if (!isActionTokenFormat(rawToken)) {
    return fail(INVALID_TOKEN_MESSAGE);
  }

  let digest: string;
  try {
    digest = hashActionToken(rawToken as string);
  } catch {
    return fail(INVALID_TOKEN_MESSAGE);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("action_tokens")
    .select(
      "id, purpose, lead_id, outreach_id, expires_at, used_at, leads(id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count), outreach_messages(id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at)",
    )
    .eq("token_hash", digest)
    .eq("purpose", purpose)
    .maybeSingle();

  if (error) return fail(INVALID_TOKEN_MESSAGE);
  if (!data) return fail(INVALID_TOKEN_MESSAGE);

  const row = data as unknown as {
    id: string;
    expires_at: string;
    used_at: string | null;
    leads: Lead;
    outreach_messages: OutreachMessage | null;
  };

  if (isExpired(row.expires_at)) return fail(INVALID_TOKEN_MESSAGE);

  if (!row.used_at) {
    // Best-effort audit stamp; a failure here must not block the operator.
    await supabase.from("action_tokens").update({ used_at: new Date().toISOString() }).eq("id", row.id);
  }

  return {
    ok: true,
    error: null,
    data: {
      lead: row.leads,
      outreach: row.outreach_messages,
      expiresAt: row.expires_at,
    },
  };
}

/**
 * Attach an edited follow-up draft to the token's lead.
 * Caller must already have resolved the token (and therefore have a session).
 */
export async function saveFollowUpDraft(input: {
  rawToken: string;
  subject: string;
  body: string;
}): Promise<ServiceResult<{ lead: Lead; message: OutreachMessage; created: boolean }>> {
  await requireAuthenticatedUser();

  const resolved = await resolveActionToken(input.rawToken, "followup_composer");
  if (!resolved.ok || !resolved.data) {
    return fail(INVALID_TOKEN_MESSAGE);
  }

  const { lead, outreach } = resolved.data;
  const supabase = getSupabaseAdmin();
  const payload = {
    lead_id: lead.id,
    recipient_email: lead.email,
    subject: input.subject.trim() || null,
    body: input.body.trim() || null,
    status: "draft" as const,
  };

  if (outreach) {
    const { data, error } = await supabase
      .from("outreach_messages")
      .update(payload)
      .eq("id", outreach.id)
      .select(MESSAGE_COLUMNS)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!data) return fail("The follow-up draft could not be updated.");
    return { ok: true, error: null, data: { lead, message: data as OutreachMessage, created: false } };
  }

  const { data, error } = await supabase
    .from("outreach_messages")
    .upsert(payload, { onConflict: "lead_id,recipient_normalized", ignoreDuplicates: false })
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  if (error) return fail(error.message);
  if (!data) return fail("The follow-up draft could not be saved.");

  return { ok: true, error: null, data: { lead, message: data as OutreachMessage, created: true } };
}

/** One message for every failure mode — never distinguishes cause. */
export const INVALID_TOKEN_MESSAGE = "This link is invalid or has expired.";