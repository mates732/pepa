"use server";

import { revalidatePath } from "next/cache";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { findLeadByEmail } from "@/lib/services/lead-service";
import { createDraft } from "@/lib/services/outreach-service";
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