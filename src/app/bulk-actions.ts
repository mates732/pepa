"use server";

/**
 * Bulk paste — server actions.
 *
 *     PASTE → PARSE → PREVIEW → IMPORT → REVIEW → USER SENDS
 *
 * The operator's emails are already finished. This file turns a block of them
 * into a block of normal Pepa drafts and nothing else. Three rules shape it:
 *
 *   * **Nothing is ever sent.** There is no send step here and no call to
 *     `recordOutreachSent()`. Importing twenty emails creates twenty drafts;
 *     composing in Gmail and recording the send stay the explicit per-email
 *     actions in the composer, where the quality gate and the historical hard
 *     stop live.
 *   * **A missing lead is not a blocker.** The operator wrote a finished email;
 *     whether Pepa already has a lead for the address does not change that. The
 *     lead `createDraft()` needs is created for them, with no company name —
 *     because none was supplied, and a name guessed from a domain would be a
 *     fiction written into the database as though it were known.
 *   * **The client is never trusted about eligibility.** The browser sends back
 *     the rows it wants imported; this file re-derives every one of them through
 *     `findLeadByEmail()` — the same function behind the composer's duplicate
 *     badge — immediately before creating anything. A hand-rolled request naming
 *     a historically contacted address is skipped, exactly as it would be
 *     through the UI.
 *
 * Drafts are created with `createDraft()`, the same service the composer uses, so
 * they land in `outreach_messages` at sequence 0 with the same unique key, appear
 * in the same history table, and go through the same gate when sent. That service
 * upserts rather than inserts, so importing the same batch twice refreshes the
 * existing draft and never produces a second one.
 *
 * Both actions are HTTP entry points and both call `requireAuthenticatedUser()`
 * before any database access.
 */

import { revalidatePath } from "next/cache";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { parseBulkEmails, type BulkEmailCandidate } from "@/lib/import/bulk-emails";
import {
  BULK_IMPORT_CHUNK_SIZE,
  mapWithConcurrency,
  planBulkEmails,
  type BulkDraftRequest,
  type BulkDraftResultRow,
  type BulkEmailCheck,
  type BulkEmailPlan,
} from "@/lib/import/bulk-plan";
import { findLeadByEmail } from "@/lib/services/lead-service";
import { createDraft } from "@/lib/services/outreach-service";

/**
 * How many lookups run at once.
 *
 * Every check is a small indexed lookup against two tables, so the cost of this
 * number is Supabase round trips, not load. Eight keeps a 100-email paste
 * responsive without looking like a burst. See `mapWithConcurrency` for why a
 * fixed width beats `Promise.all` here.
 */
const BULK_CONCURRENCY = 8;

/** Refuse to act on a single request larger than one chunk plus slack. */
const MAX_ROWS_PER_REQUEST = BULK_IMPORT_CHUNK_SIZE * 3;

/** The same caps the composer applies, applied here so a bulk paste is not a way round them. */
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 200_000;

export interface BulkActionFailure {
  ok: false;
  error: string;
}

export type BulkPreviewActionResult =
  | { ok: true; plan: BulkEmailPlan }
  | BulkActionFailure;

export type BulkImportActionResult =
  | { ok: true; rows: BulkDraftResultRow[] }
  | BulkActionFailure;

function failure(error: string): BulkActionFailure {
  return { ok: false, error };
}

/**
 * Check one recipient against the lead database and the imported history.
 *
 * A throw here means the history could not be read. That is captured as
 * `ok: false` rather than swallowed, so `planBulkEmails` marks the row `failed`
 * and refuses to import it.
 */
async function checkRecipient(index: number, recipient: string | null): Promise<BulkEmailCheck> {
  if (!recipient) {
    return { index, ok: false, check: null, error: "No recipient address on this row." };
  }

  try {
    const result = await findLeadByEmail(recipient);
    if (!result.ok || !result.data) {
      return { index, ok: false, check: null, error: result.error ?? "Duplicate check failed." };
    }
    return { index, ok: true, check: result.data, error: null };
  } catch (error) {
    return {
      index,
      ok: false,
      check: null,
      error: error instanceof Error ? error.message : "Duplicate check failed.",
    };
  }
}

/**
 * Parse a pasted block and describe every email, without writing anything.
 *
 * The preview is advisory, which is why the import re-checks. It exists so the
 * operator sees "23 ready, 7 already contacted" before committing to anything,
 * rather than after.
 */
export async function previewBulkEmails(text: string): Promise<BulkPreviewActionResult> {
  await requireAuthenticatedUser();

  const parsed = parseBulkEmails(text ?? "");
  if (parsed.candidates.length === 0) {
    return failure(
      parsed.truncated > 0
        ? "Nothing to parse — the paste exceeded the per-paste limit."
        : "Nothing to parse. Paste your finished emails, separated by `---` or a blank line.",
    );
  }

  // Rows the parser already refused need no database round trip, so only the
  // readable ones are checked. That keeps a paste full of typos fast.
  const checkable = parsed.candidates.filter(
    (candidate: BulkEmailCandidate) => candidate.status === "parsed" && candidate.recipient,
  );
  const checks = await mapWithConcurrency(checkable, BULK_CONCURRENCY, (candidate) =>
    checkRecipient(candidate.index, candidate.recipient),
  );

  const plan = planBulkEmails(parsed.candidates, checks, {
    splitBy: parsed.splitBy,
    truncated: parsed.truncated,
  });

  return { ok: true, plan };
}

/**
 * Create the drafts for one chunk of a paste.
 *
 * `rows` is a request, not an instruction. Every row is re-checked against the
 * same identity rules the composer uses, and only a row that carries no block
 * reason reaches `createDraft()`. Because `createDraft()` is the composer's own
 * service — it creates the lead when there is none, and upserts the draft on
 * `(lead_id, recipient_normalized, sequence_number)` — a repeated import updates
 * the existing slot-0 draft rather than piling up copies, which is what makes a
 * retry of this exact request a no-op rather than a duplicate send.
 */
export async function importBulkEmails(rows: BulkDraftRequest[]): Promise<BulkImportActionResult> {
  await requireAuthenticatedUser();

  const requests = (rows ?? []).filter(
    (row): row is BulkDraftRequest =>
      Boolean(row) && typeof row.recipient === "string" && row.recipient.length > 0,
  );
  if (requests.length === 0) return failure("No emails to import.");
  if (requests.length > MAX_ROWS_PER_REQUEST) {
    return failure(
      `Too many rows in one request (${requests.length}). Import in batches of ${BULK_IMPORT_CHUNK_SIZE}.`,
    );
  }

  const checks = await mapWithConcurrency(requests, BULK_CONCURRENCY, (row) =>
    checkRecipient(row.index, row.recipient),
  );

  const results: BulkDraftResultRow[] = [];

  for (let i = 0; i < requests.length; i += 1) {
    const row = requests[i]!;
    const check = checks[i]!;

    if (!check.ok || !check.check) {
      results.push({
        index: row.index,
        recipient: row.recipient,
        outcome: "skipped",
        messageId: null,
        leadId: null,
        error: check.error ?? "Duplicate check failed.",
      });
      continue;
    }

    // The re-check is the gate. Everything below this line is bookkeeping.
    if (check.check.historicalContact || !check.check.canContact) {
      results.push({
        index: row.index,
        recipient: row.recipient,
        outcome: "skipped",
        messageId: null,
        leadId: null,
        error: check.check.historicalContact
          ? "Already on record — the imported history blocks a new cold outreach here."
          : `Cannot start a new outreach: ${check.check.blockReason ?? "blocked"}.`,
      });
      continue;
    }

    // No lead yet? Not a problem. `createDraft()` creates the one it needs from
    // the recipient address alone, so an address Pepa has never seen gets the
    // same slot-0 draft as a known one. There is no company name to pass, and
    // none is guessed — see the module note.
    const lead = check.check.lead;

    const saved = await createDraft({
      recipientEmail: row.recipient,
      mainSubject: (row.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
      mainBody: (row.body ?? "").slice(0, MAX_BODY_LENGTH),
      // Follow-up starts as a copy of the main email; the operator can
      // rewrite it independently in the composer before sending.
      followUpSubject: (row.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
      followUpBody: (row.body ?? "").slice(0, MAX_BODY_LENGTH),
      // The lead's own company and contact name, which the operator set. `null`
      // for a new lead rather than something derived from the domain.
      companyName: lead?.company_name ?? null,
      contactName: lead?.contact_name ?? null,
    });

    if (!saved.ok || !saved.data) {
      results.push({
        index: row.index,
        recipient: row.recipient,
        outcome: "failed",
        messageId: null,
        leadId: lead?.id ?? null,
        error: saved.error ?? "Draft could not be saved.",
      });
      continue;
    }

    results.push({
      index: row.index,
      recipient: saved.data.main.recipient_email,
      // `createDraft()` reports `created: true` on its upsert path whatever
      // happened, because the guarantee that matters there is the one Postgres
      // makes: slot 0 is refreshed in place, never duplicated. So "was this
      // already a draft?" is answered from the lead's message count, captured by
      // the re-check immediately above — the same read the composer's badge uses.
      outcome: check.check.messageCount > 0 ? "already_present" : "created",
      messageId: saved.data.main.id,
      leadId: saved.data.lead.id,
      error: null,
    });
  }

  if (results.some((row) => row.outcome === "created")) revalidatePath("/");

  return { ok: true, rows: results };
}