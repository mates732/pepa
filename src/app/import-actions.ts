"use server";

import type { OpenInGmailResult } from "@/app/actions";
import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { buildComposeUrls } from "@/lib/outreach/gmail-compose";
import { saveImportedDraft, resolveOutreachImport } from "@/lib/services/import-service";

export type SaveImportResult =
  | { ok: true; savedAt: string }
  | { ok: false; error: string };

/**
 * Persist edits made on an imported draft.
 *
 * Authenticated first, then the import token is re-resolved server-side with the
 * `outreach_import` purpose. The client never supplies a lead or message id, so
 * a crafted request cannot retarget a token or edit a different message.
 */
export async function saveImport(input: {
  token: string;
  subject: string;
  body: string;
}): Promise<SaveImportResult> {
  await requireAuthenticatedUser();

  const result = await saveImportedDraft({
    rawToken: input.token,
    subject: input.subject,
    body: input.body,
  });

  return result;
}

/**
 * Statuses whose text may still be composed as a draft.
 *
 * Mirrors the guard `saveImportedDraft` already applies, so an import link can
 * never become a way to reopen an email that has already gone out.
 */
const COMPOSABLE_STATUSES = new Set(["draft", "ready"]);

/**
 * Build a Gmail compose URL for the imported draft behind an import link.
 *
 * This is the ChatGPT → PEPA → Gmail step. It closes the gap the deep link
 * always had: `/import/<token>` could show and edit the prepared draft, but the
 * only route to Gmail was to save it and then find it again in Outreach
 * history.
 *
 * The security properties are the ones the rest of the deep-link system already
 * enforces, not new ones:
 *
 *   * a PEPA session is required first, so private lead data is never reachable
 *     anonymously;
 *   * the token is re-resolved server-side with the `outreach_import` purpose, so
 *     a follow-up token cannot be replayed here and a token minted for another
 *     lead cannot be retargeted;
 *   * the browser sends ONLY a token. It never names a message, a lead, a
 *     recipient, a subject or a body, so it cannot compose an email to an
 *     address of its choosing;
 *   * the URL is built from the STORED row by the same `buildGmailComposeUrl`
 *     service the dashboard uses, so the browser cannot construct one;
 *   * it only reads. No status, no `sent_at`, no counter. Opening Gmail is not
 *     sending, and nothing here can send anything.
 */
export async function openImportInGmail(input: { token: string }): Promise<OpenInGmailResult> {
  await requireAuthenticatedUser();

  const resolved = await resolveOutreachImport(input?.token);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  const { message } = resolved.data;
  if (!COMPOSABLE_STATUSES.has(message.status)) {
    return {
      ok: false,
      error: "This message has already been sent and can no longer be opened as a draft.",
    };
  }

  const sequenceNumber = Number(message.sequence_number ?? 0);

  const urls = buildComposeUrls({
    to: message.recipient_email,
    subject: message.subject,
    body: message.body,
  });

  return {
    ok: true,
    mailtoUrl: urls.mailto,
    webUrl: urls.web,
    sequenceNumber,
    isFollowUp: sequenceNumber > 0,
  };
}
