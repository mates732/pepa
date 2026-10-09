"use server";

import { revalidatePath } from "next/cache";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { createDraft } from "@/lib/services/outreach-service";

export interface UpdateDraftInput {
  messageId: string;
  recipientEmail: string;
  subject: string;
  body: string;
}

export interface UpdateDraftResult {
  ok: true;
  message: {
    id: string;
    recipient_email: string;
    subject: string | null;
    body: string | null;
    sequence_number: number;
  };
}

export interface UpdateDraftFailure {
  ok: false;
  error: string;
}

export type UpdateDraftResponse = UpdateDraftResult | UpdateDraftFailure;

function failure(error: string): UpdateDraftFailure {
  return { ok: false, error };
}

/**
 * Update an existing draft by its message ID.
 * Uses the same createDraft service which handles upserts.
 */
export async function updateDraft(input: UpdateDraftInput): Promise<UpdateDraftResponse> {
  await requireAuthenticatedUser();

  const { messageId, recipientEmail, subject, body } = input;

  if (!messageId) return failure("A message ID is required.");

  const recipient = normalizeEmail(recipientEmail ?? "");
  if (!recipient) return failure("A recipient email is required.");
  if (!isValidEmail(recipient)) {
    return failure(`"${recipient}" is not a valid email address.`);
  }

  const mainSubject = subject.trim();
  const mainBody = body.trim();
  if (!mainSubject) return failure("A subject is required.");
  if (!mainBody) return failure("A body is required.");

  try {
    // Use the existing createDraft service which handles updates when messageId is provided
    // The messageId needs to be prefixed with "main_" to indicate it's a main draft update
    const result = await createDraft({
      recipientEmail: recipient,
      mainSubject,
      mainBody,
      followUps: [], // Don't modify follow-ups when editing a single draft
      messageId: `main_${messageId}`,
    });

    if (!result.ok || !result.data) {
      return failure(result.error ?? "Could not update the draft.");
    }

    revalidatePath("/");

    return {
      ok: true,
      message: {
        id: result.data.main.id,
        recipient_email: result.data.main.recipient_email,
        subject: result.data.main.subject,
        body: result.data.main.body,
        sequence_number: result.data.main.sequence_number,
      },
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Could not update the draft.");
  }
}