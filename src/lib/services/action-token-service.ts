import "server-only";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import {
  ACTION_TOKEN_PURPOSES,
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
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id";

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
  /** Defaults to the follow-up purpose; imports pass "outreach_import". */
  purpose?: ActionTokenPurpose;
}): Promise<ServiceResult<{ token: string; expiresAt: string; id: string }>> {
  if (!input.leadId) return fail("A lead is required to mint a follow-up link.");
  if (input.purpose && !ACTION_TOKEN_PURPOSES.includes(input.purpose)) {
    return fail("Unknown action-token purpose.");
  }

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
      purpose: input.purpose ?? "followup_composer",
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
      "id, purpose, lead_id, outreach_id, expires_at, used_at, leads(id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count), outreach_messages(id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id)",
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
 */export async function saveFollowUpDraft(input: {
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

  if (!outreach) {
    // No anchor message: this is an initial outreach, which always occupies
    // sequence slot 0. Upserting on the sequence key keeps the pre-existing
    // "one open draft per recipient" behaviour.
    const { data, error } = await supabase
      .from("outreach_messages")
      .upsert({ ...payload, sequence_number: 0, parent_message_id: null }, {
        onConflict: "lead_id,recipient_normalized,sequence_number",
        ignoreDuplicates: false,
      })
      .select(MESSAGE_COLUMNS)
      .maybeSingle();

    if (error) return fail(error.message);
    if (!data) return fail("The follow-up draft could not be saved.");

    return { ok: true, error: null, data: { lead, message: data as OutreachMessage, created: true } };
  }

  // The token carries an anchor: this draft is a follow-up to `outreach`.
  //
  // It gets its OWN row at the next sequence slot. It must never be written
  // over the anchor, because the anchor is the historical record of what was
  // actually sent to this recipient; overwriting it destroyed that history.
  //
  // Re-saving an unsent follow-up updates that same follow-up row rather than
  // appending a new one, so pressing save twice cannot inflate the sequence.
  const existing = await openFollowUpAfter(supabase, lead.id, outreach.id);
  if (existing) {
    const { data, error } = await supabase
      .from("outreach_messages")
      .update(payload)
      .eq("id", existing.id)
      .select(MESSAGE_COLUMNS)
      .maybeSingle();

    if (error) return fail(error.message);
    if (!data) return fail("The follow-up draft could not be updated.");
    return { ok: true, error: null, data: { lead, message: data as OutreachMessage, created: false } };
  }

  const next = await nextSequenceNumber(supabase, lead.id, lead.email);
  if (next === null) return fail("The follow-up draft could not be saved.");

  const { data, error } = await supabase
    .from("outreach_messages")
    .insert({
      ...payload,
      sequence_number: next,
      parent_message_id: outreach.id,
    })
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  if (error) {
    // A concurrent save claimed the same slot. The unique index is the
    // authority, so report a conflict rather than writing a duplicate.
    if (error.code === "23505") {
      return fail("A follow-up draft for this recipient is already open. Reopen it instead.");
    }
    return fail(error.message);
  }
  if (!data) return fail("The follow-up draft could not be saved.");

  return { ok: true, error: null, data: { lead, message: data as OutreachMessage, created: true } };
}

/** The unsent follow-up that already follows `anchorMessageId`, if any. */
async function openFollowUpAfter(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  leadId: string,
  anchorMessageId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("outreach_messages")
    .select("id")
    .eq("parent_message_id", anchorMessageId)
    .eq("lead_id", leadId)
    .in("status", ["draft", "ready"])
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as { id: string } | null) ?? null;
}

/** The next free sequence slot for this lead/recipient. */
async function nextSequenceNumber(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  leadId: string,
  recipientEmail: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("outreach_messages")
    .select("sequence_number")
    .eq("lead_id", leadId)
    .eq("recipient_email", recipientEmail)
    .order("sequence_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  const highest = Number((data as { sequence_number?: number } | null)?.sequence_number ?? -1);
  return Number.isFinite(highest) ? highest + 1 : null;
}

/** One message for every failure mode — never distinguishes cause. */
export const INVALID_TOKEN_MESSAGE = "This link is invalid or has expired.";