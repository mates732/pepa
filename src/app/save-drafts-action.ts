"use server";

import { revalidatePath } from "next/cache";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { parseBulkEmails, type BulkEmailCandidate } from "@/lib/import/bulk-emails";
import { findLeadByEmail } from "@/lib/services/lead-service";
import { createDraft } from "@/lib/services/outreach-service";

export interface SaveDraftsActionResult {
  ok: true;
  created: number;
  updated: number;
  unchanged: number;
  skipped_duplicate: number;
  skipped_already_contacted: number;
  rejected_invalid: number;
  failed: number;
  details: Array<{
    index: number;
    recipient: string | null;
    outcome: "created" | "updated" | "unchanged" | "skipped_duplicate" | "skipped_already_contacted" | "rejected_invalid" | "failed";
    messageId: string | null;
    leadId: string | null;
    error: string | null;
  }>;
}

export interface SaveDraftsActionFailure {
  ok: false;
  error: string;
}

export type SaveDraftsResult = SaveDraftsActionResult | SaveDraftsActionFailure;

const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 200_000;

/**
 * Save drafts from a bulk paste of finished emails.
 *
 * This is the simplified V1 workflow: one textarea, one button, creates drafts.
 * Uses the same parser (parseBulkEmails) and same draft creation (createDraft)
 * as the existing bulk import, but with a simpler API.
 */
export async function saveDraftsFromPaste(text: string): Promise<SaveDraftsResult> {
  await requireAuthenticatedUser();

  const parsed = parseBulkEmails(text ?? "");
  if (parsed.candidates.length === 0) {
    return {
      ok: false,
      error:
        parsed.truncated > 0
          ? "Nothing to parse — the paste exceeded the per-paste limit."
          : "Nothing to parse. Paste your finished emails, separated by `--- LEAD NN ---` or a blank line.",
    };
  }

  // Filter to only parsed candidates with recipients
  const importable = parsed.candidates.filter(
    (c): c is BulkEmailCandidate & { recipient: string } =>
      c.status === "parsed" && c.recipient !== null,
  );

  if (importable.length === 0) {
    return {
      ok: false,
      error: "No valid emails with recipients found in the paste.",
    };
  }

  // Check each recipient against the database (concurrent)
  const checkResults = await Promise.all(
    importable.map(async (candidate) => {
      try {
        const result = await findLeadByEmail(candidate.recipient!);
        return { index: candidate.index, recipient: candidate.recipient, check: result };
      } catch (error) {
        return {
          index: candidate.index,
          recipient: candidate.recipient,
          check: { ok: false as const, error: error instanceof Error ? error.message : "Check failed" },
        };
      }
    }),
  );

  const results: SaveDraftsActionResult["details"] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped_duplicate = 0;
  let skipped_already_contacted = 0;
  let rejected_invalid = 0;
  let failed = 0;

  for (const candidate of importable) {
    const checkResult = checkResults.find((r) => r.index === candidate.index)!;

    if (!checkResult.check.ok || !checkResult.check.data) {
      results.push({
        index: candidate.index,
        recipient: candidate.recipient,
        outcome: "rejected_invalid",
        messageId: null,
        leadId: null,
        error: checkResult.check.error ?? "Duplicate check failed.",
      });
      rejected_invalid++;
      continue;
    }

    const check = checkResult.check.data;

    // Skip if historically contacted or blocked
    if (check.historicalContact || !check.canContact) {
      results.push({
        index: candidate.index,
        recipient: candidate.recipient,
        outcome: "skipped_already_contacted",
        messageId: null,
        leadId: null,
        error: check.historicalContact
          ? "Already on record — the imported history blocks a new cold outreach here."
          : `Cannot start a new outreach: ${check.blockReason ?? "blocked"}.`,
      });
      skipped_already_contacted++;
      continue;
    }

    const lead = check.lead;

    // Build follow-ups from parsed candidate
    const followUps = (candidate.followUps ?? []).map((fu) => ({
      subject: (fu.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
      body: (fu.body ?? "").slice(0, MAX_BODY_LENGTH),
    }));

    // Check if there's an existing unsent draft to compare content
    const existingDraft = check.latestUnsentMessage;
    const existingSubject = existingDraft?.subject ?? null;
    const existingBody = existingDraft?.body ?? null;

    const saved = await createDraft({
      recipientEmail: candidate.recipient,
      mainSubject: (candidate.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
      mainBody: (candidate.body ?? "").slice(0, MAX_BODY_LENGTH),
      followUps,
      companyName: lead?.company_name ?? null,
      contactName: lead?.contact_name ?? null,
    });

    if (!saved.ok || !saved.data) {
      // If the message was already sent, treat it as skipped per the
      // "never unsend" semantics. createDraft() returns a string error
      // when the existing message has status "sent".
      if (
        saved.error &&
        saved.error.startsWith("This message has already been sent")
      ) {
        results.push({
          index: candidate.index,
          recipient: candidate.recipient,
          outcome: "skipped_already_contacted",
          messageId: null,
          leadId: lead?.id ?? null,
          error: saved.error,
        });
        skipped_already_contacted++;
        continue;
      }
      results.push({
        index: candidate.index,
        recipient: candidate.recipient,
        outcome: "failed",
        messageId: null,
        leadId: lead?.id ?? null,
        error: saved.error ?? "Draft could not be saved.",
      });
      failed++;
      continue;
    }

    // Determine outcome: created, updated, or unchanged
    const newSubject = saved.data.main.subject;
    const newBody = saved.data.main.body;
    const hasExistingUnsentDraft = check.messageCount > check.sentCount;
    
    let outcome: "created" | "updated" | "unchanged";
    if (!hasExistingUnsentDraft) {
      outcome = "created";
      created++;
    } else if (existingSubject === newSubject && existingBody === newBody) {
      outcome = "unchanged";
      unchanged++;
    } else {
      outcome = "updated";
      updated++;
    }

    results.push({
      index: candidate.index,
      recipient: saved.data.main.recipient_email,
      outcome,
      messageId: saved.data.main.id,
      leadId: saved.data.lead.id,
      error: null,
    });
  }

  if (created > 0 || updated > 0 || unchanged > 0) {
    revalidatePath("/");
  }

  return {
    ok: true,
    created,
    updated,
    unchanged,
    skipped_duplicate: 0, // Parser handles duplicates before this point
    skipped_already_contacted,
    rejected_invalid,
    failed,
    details: results,
  };
}