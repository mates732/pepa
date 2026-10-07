/**
 * Bulk paste — planning.
 *
 * The pure half of the bulk workflow: it turns parsed emails plus one duplicate
 * check per recipient into the preview table, decides which emails may become
 * drafts, and folds per-email outcomes back into the totals. No database, no
 * network, no AI.
 *
 * Two rules this module exists to enforce, both of them "fail closed":
 *
 *   * A row whose history lookup ERRORED is not ready. `findLeadByEmail()`
 *     throws when `historical_outreach` cannot be read, precisely because an
 *     outreach system must never mistake "I could not check" for "nothing is on
 *     record". A bulk import that turned those failures into ready drafts would
 *     reintroduce exactly that bug at scale, so an unreadable row becomes
 *     `failed` and is not importable.
 *   * Status precedence is fixed, so the counts always add up to the number of
 *     emails the operator pasted.
 *
 * Identity is decided in two places and only two: inside one paste
 * (`parseBulkEmails`, the normalized address) and in the database
 * (`findLeadByEmail`). This module compares the answers; it never re-derives them.
 */

import type { BulkEmailCandidate } from "@/lib/import/bulk-emails";
import type { DuplicateCheckResult, HistoricalContact, OutreachBlockReason } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* types                                                                       */
/* -------------------------------------------------------------------------- */

/** What the preview shows in the Status column. */
export type BulkEmailStatus =
  /**
   * Clear of history, so importable.
   *
   * Whether a lead already exists is NOT part of this: `createDraft()` creates
   * the minimal lead a draft needs, so a recipient Pepa has never seen is as
   * importable as one it has.
   */
  | "ready"
  /** Legacy or Pep outreach on record — no new cold outreach may start. */
  | "already_contacted"
  /** The same recipient appears twice in this paste. */
  | "duplicate"
  /** Unreadable block, or a duplicate check that could not be completed. */
  | "needs_review"
  | "failed";

/** The duplicate check for one email, as the server resolved it. */
export interface BulkEmailCheck {
  /** The candidate's 1-based paste position. */
  index: number;
  /** False when the check itself failed; the reason is then in `error`. */
  ok: boolean;
  check: DuplicateCheckResult | null;
  error: string | null;
}

export interface BulkEmailRow {
  index: number;
  /** Normalized — the canonical identity. */
  recipient: string | null;
  /** Exactly as pasted. */
  subject: string | null;
  /** Exactly as pasted. */
  body: string | null;
  status: BulkEmailStatus;
  /** Why this row is not `ready`. Null when it is. */
  reason: string | null;
  /** Non-fatal parser notes, shown under the row. */
  warnings: string[];
  /** Matched lead, when there is one. */
  leadId: string | null;
  leadCompany: string | null;
  /** Machine reason behind a refusal, when the history supplied one. */
  blockReason: OutreachBlockReason | null;
  lastContactedAt: string | null;
  /** How many legacy emails went to this address, when history knows. */
  contactCount: number | null;
  /** For `duplicate`: the paste position of the email this one repeats. */
  duplicateOf: number | null;
  /** Follow-ups parsed from the same block, carried for the import. */
  followUps?: Array<{ subject: string | null; body: string | null }>;
}

export interface BulkEmailSummary {
  /** Emails the paste produced, excluding anything over the ceiling. */
  total: number;
  ready: number;
  alreadyContacted: number;
  duplicates: number;
  needsReview: number;
  failed: number;
  /** Rows `importBulkEmails` will act on. */
  importable: number;
  /** Emails the paste exceeded `MAX_BULK_EMAILS` and that were not parsed. */
  truncated: number;
}

export interface BulkEmailPlan {
  rows: BulkEmailRow[];
  summary: BulkEmailSummary;
  /** How the block was divided, for the UI caption. */
  splitBy: "recipient_header" | "separator" | "blank_line" | "single";
}

/**
 * Emails per import request.
 *
 * Lives here rather than in the actions file because a `"use server"` module may
 * only export async functions — a plain constant exported from one is a build
 * error that `tsc` does not catch. The client needs it to chunk, so it has to
 * come from a module that is allowed to export it.
 *
 * Deliberately small: the chunk size is a progress and retry boundary, not a
 * limit on the feature. The client walks the list until the paste is done.
 */
export const BULK_IMPORT_CHUNK_SIZE = 10;

/** The minimum a client must send for one email to become a draft. */
export interface BulkDraftRequest {
  index: number;
  recipient: string;
  subject: string | null;
  body: string | null;
  followUps?: Array<{ subject: string | null; body: string | null }>;
}

/* -------------------------------------------------------------------------- */
/* preview                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Human wording for a history match, mirroring the composer's badge so the two
 * surfaces cannot describe the same address differently.
 */
function historicalReason(contact: HistoricalContact): string {
  const date = contact.lastContactAt ? ` on ${contact.lastContactAt.slice(0, 10)}` : "";
  const count = `${contact.contactCount} contact${contact.contactCount === 1 ? "" : "s"}`;
  return contact.matchedOn === "domain"
    ? `Already contacted — the company domain ${contact.normalizedDomain ?? ""} has ${count} on record${date}.`.replace(
        /\s+/g,
        " ",
      )
    : `Already contacted${date} · ${count} on record.`;
}

/**
 * Status precedence, most decisive first.
 *
 * A row the parser could not read, or that repeats a recipient WITHIN the paste,
 * is reported as such regardless of what the database says — that is the
 * operator's typo to fix, and telling them "already contacted" about a row they
 * mistyped would hide the real problem.
 *
 * Below that the ONLY refusal is history. An address the legacy account pitched
 * is contacted whether or not Pepa holds a lead for it, and history must win
 * either way. Everything else is `ready`: a recipient with no lead is not a
 * problem to report, because `createDraft()` creates the lead it needs. The
 * preview's job is to tell the operator what may not be sent, and "Pepa has not
 * heard of this company yet" is not that.
 */
function decideStatus(
  candidate: BulkEmailCandidate,
  check: BulkEmailCheck | undefined,
): { status: BulkEmailStatus; reason: string | null } {
  if (candidate.status === "needs_review") {
    return { status: "needs_review", reason: candidate.reason };
  }
  if (candidate.status === "duplicate") {
    return { status: "duplicate", reason: candidate.reason };
  }
  if (!check) {
    return {
      status: "failed",
      reason: "This recipient was not checked against the lead database.",
    };
  }
  if (!check.ok) {
    return {
      status: "failed",
      reason: `Duplicate check failed: ${check.error ?? "unknown error"}. Not imported — this must never be assumed safe.`,
    };
  }
  if (!check.check) {
    return { status: "failed", reason: "Duplicate check returned no result." };
  }

  const result = check.check;
  if (result.historicalContact) {
    return { status: "already_contacted", reason: historicalReason(result.historicalContact) };
  }
  if (!result.canContact && result.blockReason) {
    // `canContact` can only be false because of history, but a future block
    // reason must still reach the operator rather than read as "ready".
    return {
      status: "already_contacted",
      reason: `Cannot start a new outreach: ${result.blockReason}.`,
    };
  }
  return { status: "ready", reason: null };
}

/**
 * Build the preview.
 *
 * `checks` may be short: a caller that has not checked a row yet still gets a
 * usable plan, and that row is `failed` rather than `ready`. Guessing would be
 * the one outcome this feature must not produce.
 */
export function planBulkEmails(
  candidates: BulkEmailCandidate[],
  checks: BulkEmailCheck[],
  options: { splitBy?: BulkEmailPlan["splitBy"]; truncated?: number } = {},
): BulkEmailPlan {
  const byIndex = new Map(checks.map((check) => [check.index, check]));

  const rows = candidates.map((candidate) => {
    const check = byIndex.get(candidate.index);
    const { status, reason } = decideStatus(candidate, check);
    const result = check?.ok ? check.check : null;

    return {
      index: candidate.index,
      recipient: candidate.recipient,
      subject: candidate.subject,
      body: candidate.body,
      status,
      reason,
      warnings: candidate.warnings,
      leadId: result?.lead?.id ?? null,
      leadCompany: result?.lead?.company_name ?? null,
      blockReason: result?.blockReason ?? null,
      lastContactedAt: result?.lastContactedAt ?? null,
      contactCount: result?.historicalContact?.contactCount ?? null,
      duplicateOf: candidate.duplicateOf,
      followUps: candidate.followUps,
    } satisfies BulkEmailRow;
  });

  const count = (status: BulkEmailStatus) => rows.filter((row) => row.status === status).length;

  const summary: BulkEmailSummary = {
    total: rows.length,
    ready: count("ready"),
    alreadyContacted: count("already_contacted"),
    duplicates: count("duplicate"),
    needsReview: count("needs_review"),
    failed: count("failed"),
    // Everything that is not a refusal, a typo or an unreadable row. A missing
    // lead is not among them — `createDraft()` resolves the lead itself.
    importable: count("ready"),
    truncated: options.truncated ?? 0,
  };

  return {
    rows,
    summary,
    splitBy: options.splitBy ?? "single",
  };
}

/**
 * The emails an import will act on, in paste order.
 *
 * The subject and body travel with the request because the draft has to contain
 * the operator's own words. They are re-validated server-side, but they are the
 * operator's text and must not be replaced with anything else.
 */
export function importableRequests(plan: BulkEmailPlan): BulkDraftRequest[] {
  return plan.rows
    .filter((row) => row.status === "ready" && row.recipient)
    .map((row) => ({
      index: row.index,
      recipient: row.recipient!,
      subject: row.subject,
      body: row.body,
      followUps: row.followUps,
    }));
}

/* -------------------------------------------------------------------------- */
/* import outcomes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What happened to one email.
 *
 * `created` and `already_present` are both SUCCESS: `createDraft()` upserts on
 * `(lead_id, recipient_normalized, sequence_number)`, so a retry cannot produce a
 * second draft, and reporting the retry honestly is what keeps the summary stable
 * across attempts.
 */
export type BulkDraftOutcome =
  | "created"
  | "already_present"
  /** Not importable — skipped without touching the database. */
  | "skipped"
  | "failed";

export interface BulkDraftResultRow {
  index: number;
  recipient: string;
  outcome: BulkDraftOutcome;
  messageId: string | null;
  leadId: string | null;
  error: string | null;
}

export interface BulkDraftTotals {
  /** Drafts that did not previously exist. */
  ready: number;
  /** Drafts that were already saved — a retry, or a re-saved paste. */
  alreadyPresent: number;
  skipped: number;
  failed: number;
  /** `ready + alreadyPresent` — the drafts this batch produced or found. */
  succeeded: number;
}

export function summarizeOutcomes(rows: BulkDraftResultRow[]): BulkDraftTotals {
  const count = (outcome: BulkDraftOutcome) =>
    rows.filter((row) => row.outcome === outcome).length;

  const ready = count("created");
  const alreadyPresent = count("already_present");
  const skipped = count("skipped");
  const failed = count("failed");

  return {
    ready,
    alreadyPresent,
    skipped,
    failed,
    succeeded: ready + alreadyPresent,
  };
}

/** Just the rows that failed, in paste order — what a retry re-sends. */
export function failedRows(rows: BulkDraftResultRow[]): BulkDraftRequest[] {
  return rows
    .filter((row) => row.outcome === "failed")
    .map((row) => ({ index: row.index, recipient: row.recipient, subject: null, body: null }));
}

/* -------------------------------------------------------------------------- */
/* concurrency                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run `worker` over `items` with a fixed number in flight, preserving input
 * order in the result.
 *
 * The bulk workflow hits Supabase once or twice per email, so 100 pasted emails
 * is 100+ round trips. `Promise.all` would fire all of them at once; chunking
 * would stall the UI between chunks and lose the other failures. A fixed width
 * keeps the request rate bounded without hiding a failure behind a later chunk,
 * and because `succeeded`/`failed` are tracked per row, one rejected lookup
 * costs that row only.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: width }, run));
  return results;
}