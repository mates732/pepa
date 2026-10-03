"use server";

import { revalidatePath } from "next/cache";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { findLeadByEmail } from "@/lib/services/lead-service";
import { createDraft, recordOutreachSent as recordOutreachSentService } from "@/lib/services/outreach-service";
import type { DuplicateCheckResult, Lead, OutreachMessage } from "@/lib/types";

/**
 * IMPORTANT: both actions below are unauthenticated HTTP entry points. Each one
 * calls `requireAuthenticatedUser()` FIRST — it throws `AuthenticationError`
 * before any Supabase access, so hiding the UI is never the only defence.
 */

export interface ActionFailure {
  ok: false;
  error: string;
}

export type CheckRecipientResult =
  | { ok: true; data: DuplicateCheckResult }
  | ActionFailure;

export type SaveDraftResult =
  | { ok: true; lead: Lead; message: OutreachMessage; created: boolean }
  | ActionFailure;

function failure(error: string): ActionFailure {
  return { ok: false, error };
}

/**
 * Server-side duplicate check. The browser never queries Supabase directly,
 * so the badge always reflects what is actually stored.
 */
export async function checkRecipient(recipient: string): Promise<CheckRecipientResult> {
  await requireAuthenticatedUser();

  const email = normalizeEmail(recipient ?? "");
  if (!email) return failure("Paste a recipient email first.");
  if (!isValidEmail(email)) return failure(`"${email}" is not a valid email address.`);

  try {
    const result = await findLeadByEmail(email);
    if (!result.ok || !result.data) return failure(result.error ?? "Duplicate check failed.");
    return { ok: true, data: result.data };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Duplicate check failed.");
  }
}

/** Persist the composer contents as a draft and refresh the history table. */
export async function saveDraft(input: {
  recipientEmail: string;
  subject: string;
  body: string;
  companyName?: string | null;
  contactName?: string | null;
  messageId?: string | null;
}): Promise<SaveDraftResult> {
  await requireAuthenticatedUser();

  const recipientEmail = normalizeEmail(input.recipientEmail ?? "");
  if (!recipientEmail) return failure("A recipient email is required.");
  if (!isValidEmail(recipientEmail)) {
    return failure(`"${recipientEmail}" is not a valid email address.`);
  }

  const subject = (input.subject ?? "").slice(0, 998);
  const body = (input.body ?? "").slice(0, 200_000);
  if (!subject.trim()) return failure("A subject is required to save a draft.");
  if (!body.trim()) return failure("A body is required to save a draft.");

  try {
    const result = await createDraft({
      recipientEmail,
      subject,
      body,
      companyName: input.companyName?.slice(0, 200) ?? null,
      contactName: input.contactName?.slice(0, 200) ?? null,
      messageId: input.messageId ?? null,
    });
    if (!result.ok || !result.data) {
      return failure(result.error ?? "Could not save the draft.");
    }
    revalidatePath("/");
    return { ok: true, ...result.data };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Could not save the draft.");
  }
}

/** Postgres rejects a malformed uuid; catch it here so no driver detail leaks. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecordOutreachSentResult =
  | {
      ok: true;
      outcome: "recorded" | "already_sent";
      message: OutreachMessage;
      nextFollowUpAt: string | null;
    }
  | ActionFailure;

/**
 * Record that the operator has already sent a draft from their own mail client.
 *
 * This is NOT a send. PEPA has no email provider and makes no outbound mail
 * request; the operator sends the email elsewhere and then tells PEPA the
 * fact, so the follow-up engine can see that real outreach happened.
 *
 * The transition is owned by `recordOutreachSent()`, which compare-and-sets on
 * the database and is therefore safe to submit twice: the second call reports
 * `already_sent` and schedules nothing further.
 */
export async function recordOutreachSent(input: {
  messageId: string;
  leadId: string;
}): Promise<RecordOutreachSentResult> {
  await requireAuthenticatedUser();

  const messageId = String(input?.messageId ?? "");
  const leadId = String(input?.leadId ?? "");

  if (!UUID_PATTERN.test(messageId)) return failure("That message could not be identified.");
  if (!UUID_PATTERN.test(leadId)) return failure("That lead could not be identified.");

  try {
    const result = await recordOutreachSentService({ messageId, leadId });
    if (!result.ok || !result.data) {
      return failure(result.error ?? "Could not record the send.");
    }

    revalidatePath("/");
    return {
      ok: true,
      outcome: result.data.outcome,
      message: result.data.message,
      // An idempotent repeat has no new schedule, so it never claims one.
      nextFollowUpAt: result.data.outcome === "recorded" ? result.data.nextFollowUpAt : null,
    };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Could not record the send.",
    );
  }
}