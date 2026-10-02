import "server-only";

import { buildImportDeepLink } from "@/lib/config/base-url";
import { IMPORT_TOKEN_TTL_MS } from "@/lib/deep-link/tokens";
import {
  MAX_IMPORT_BODY,
  MAX_IMPORT_NAME,
  MAX_IMPORT_SUBJECT,
  validateOutreachImport,
  type ImportValidation,
  type OutreachImportInput,
  type OutreachImportPayload,
} from "@/lib/import/outreach-import";
import { createLead } from "@/lib/services/lead-service";
import { mintFollowUpToken, resolveActionToken } from "@/lib/services/action-token-service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Lead, OutreachMessage } from "@/lib/types";

/**
 * ChatGPT -> PEPA outreach import.
 *
 * PEPA never calls an LLM and holds no AI credential. ChatGPT (or the operator
 * pasting its output) hands PEPA a structured payload; PEPA validates it,
 * normalises it, applies the existing dedupe rules, stores it as an ordinary
 * *draft*, and returns a short-lived opaque link. Opening that link shows the
 * composer — nothing is ever sent automatically.
 *
 * Two properties the rest of PEPA already relies on:
 *
 *   IMPORT != SENT.  The payload lands in `outreach_messages` with status
 *   'draft' and `sent_at` NULL. It becomes 'sent' only when a provider really
 *   sends it, which is a later phase.
 *
 *   The database is the authority.  Dedupe is decided by the unique indexes on
 *   `leads.email_normalized` and (lead_id, recipient_normalized), not by a
 *   check the caller could skip. The application additionally refuses to
 *   overwrite a message that has already left the outbox.
 */

export const IMPORT_PURPOSE = "outreach_import";

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at";

/**
 * A message in one of these states has either gone out or been closed off.
 * Re-importing over it would rewrite history or re-contact a closed lead, so it
 * is refused. Matches the `CONTACTED_STATUSES` rule the duplicate badge uses.
 */
const LOCKED_STATUSES = new Set(["sent", "follow_up", "replied", "completed", "blocked"]);

export type ImportOutcome =
  | {
      ok: true;
      deepLink: string;
      recipient: string;
      /** False when an existing draft for this recipient was refreshed. */
      created: boolean;
      alreadyContacted: boolean;
      expiresAt: string;
    }
  | { ok: false; error: string; reason: ImportFailureReason };

export type ImportFailureReason =
  | "invalid_payload"
  | "already_contacted"
  | "store_failed";

export interface ResolvedImport {
  lead: Lead;
  message: OutreachMessage;
  /** The payload is still a draft; the UI must say so. */
  imported: true;
  /** When the import link itself stops working. */
  expiresAt: string;
}

/**
 * Validate, store and mint an import link.
 *
 * Returns the deep link and nothing else: no token, no lead id, no payload echo.
 */
export async function createOutreachImport(
  input: OutreachImportInput,
): Promise<ImportOutcome> {
  const validation = validateOutreachImport(input);
  if (!validation.ok) return rejected("invalid_payload", validation.error);

  const { recipient, subject, body, companyName, contactName } = validation.payload;

  const leadResult = await createLead({ email: recipient, companyName, contactName });
  if (!leadResult.ok || !leadResult.data) {
    return rejected("store_failed", leadResult.error ?? "Lead could not be resolved.");
  }
  const lead = leadResult.data;

  const existing = await currentMessage(lead.id, recipient);
  if (existing && LOCKED_STATUSES.has(existing.status)) {
    // The authoritative dedupe answer: this recipient has been contacted.
    return rejected("already_contacted", alreadyContactedMessage(existing));
  }

  const supabase = getSupabaseAdmin();
  const payload = {
    lead_id: lead.id,
    recipient_email: recipient,
    subject,
    body,
    // Never 'sent': an import is a draft until a provider sends it.
    status: "draft" as const,
    provider: null,
    provider_message_id: null,
    sent_at: null,
  };

  // Upsert on the existing unique key: a repeated import of the same recipient
  // refreshes one draft instead of piling up outreach records.
  const { data, error } = await supabase
    .from("outreach_messages")
    .upsert(payload, { onConflict: "lead_id,recipient_normalized", ignoreDuplicates: false })
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  if (error) return rejected("store_failed", "The imported draft could not be stored.");
  if (!data) return rejected("store_failed", "The imported draft could not be stored.");

  const message = data as OutreachMessage;

  const minted = await mintFollowUpToken({
    leadId: lead.id,
    outreachId: message.id,
    ttlMs: IMPORT_TOKEN_TTL_MS,
    purpose: IMPORT_PURPOSE,
  });
  if (!minted.ok || !minted.data) {
    return rejected("store_failed", "The import link could not be created.");
  }

  return {
    ok: true,
    deepLink: await buildImportDeepLink(minted.data.token),
    recipient,
    created: !existing,
    alreadyContacted: false,
    expiresAt: minted.data.expiresAt,
  };
}

/**
 * Resolve an import token to its stored draft.
 *
 * The token is purpose-scoped, so a follow-up token and an import token are not
 * interchangeable, and every failure mode — malformed, unknown, expired, wrong
 * purpose — collapses to one indistinguishable error.
 */
export async function resolveOutreachImport(rawToken: string | null | undefined): Promise<
  | { ok: true; data: ResolvedImport }
  | { ok: false; error: string }
> {
  const resolved = await resolveActionToken(rawToken, IMPORT_PURPOSE);
  if (!resolved.ok || !resolved.data) {
    return { ok: false, error: resolved.error ?? "This link is invalid or has expired." };
  }

  const { lead, outreach } = resolved.data;
  if (!outreach) {
    return { ok: false, error: "This link is invalid or has expired." };
  }

  return { ok: true, data: { lead, message: outreach, imported: true, expiresAt: resolved.data.expiresAt } };
}

/**
 * Persist edits to an imported draft.
 *
 * Re-validates with the same limits the entry point used, and refuses to touch
 * a message that is no longer a draft — an import link must never become a way
 * to rewrite an already-sent email.
 */
export async function saveImportedDraft(input: {
  rawToken: string;
  subject: string;
  body: string;
}): Promise<{ ok: true; savedAt: string } | { ok: false; error: string }> {
  const resolved = await resolveOutreachImport(input.rawToken);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (!["draft", "ready"].includes(resolved.data.message.status)) {
    return { ok: false, error: "This message has already been sent and can no longer be edited." };
  }

  const subject = String(input.subject ?? "").trim();
  const body = String(input.body ?? "").trim();

  if (!subject) return { ok: false, error: "A subject is required." };
  if (subject.length > MAX_IMPORT_SUBJECT) {
    return { ok: false, error: `Subject is too long (maximum ${MAX_IMPORT_SUBJECT} characters).` };
  }
  if (!body) return { ok: false, error: "A body is required." };
  if (body.length > MAX_IMPORT_BODY) {
    return { ok: false, error: `Body is too long (maximum ${MAX_IMPORT_BODY} characters).` };
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("outreach_messages")
    .update({ subject, body, status: "draft" })
    .eq("id", resolved.data.message.id)
    .in("status", ["draft", "ready"]);

  if (error) return { ok: false, error: "The imported draft could not be saved." };

  return { ok: true, savedAt: new Date().toISOString() };
}

/** Re-exported so callers validate and store through one import. */
export type { ImportValidation, OutreachImportPayload };

function rejected(reason: ImportFailureReason, error: string): ImportOutcome {
  return { ok: false, error, reason };
}

function alreadyContactedMessage(message: OutreachMessage): string {
  const when = message.sent_at
    ? ` Last contact was ${message.sent_at.slice(0, 10)}.`
    : "";
  return `Lead already contacted — this recipient has a ${message.status} message.${when}`;
}

/** The single existing message row for (lead, normalized recipient), if any. */
async function currentMessage(
  leadId: string,
  recipient: string,
): Promise<OutreachMessage | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("lead_id", leadId)
    .eq("recipient_email", recipient)
    .maybeSingle();

  if (error) return null;
  return (data as OutreachMessage | null) ?? null;
}

export { MAX_IMPORT_BODY, MAX_IMPORT_NAME, MAX_IMPORT_SUBJECT };