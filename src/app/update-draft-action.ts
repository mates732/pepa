"use server";

import { revalidatePath } from "next/cache";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { updateMessage } from "@/lib/services/outreach-service";

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
 * Uses updateMessage to update the message directly by ID, preserving
 * message ID, lead_id, sequence_number, and parent_message_id.
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
    const result = await updateMessage({
      messageId,
      recipientEmail: recipient,
      subject: mainSubject,
      body: mainBody,
    });

    if (!result.ok || !result.data) {
      return failure(result.error ?? "Could not update the draft.");
    }

    revalidatePath("/");

    return {
      ok: true,
      message: {
        id: result.data.id,
        recipient_email: result.data.recipient_email,
        subject: result.data.subject,
        body: result.data.body,
        sequence_number: result.data.sequence_number,
      },
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "Could not update the draft.");
  }
}