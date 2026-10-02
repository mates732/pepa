"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import {
  INVALID_TOKEN_MESSAGE,
  saveFollowUpDraft,
} from "@/lib/services/action-token-service";

export type SaveFollowUpResult =
  | { ok: true; savedAt: string; created: boolean }
  | { ok: false; error: string };

const MAX_SUBJECT = 998;
const MAX_BODY = 200_000;

/**
 * Persist edits made on a follow-up deep link.
 *
 * Authenticated first, then the token is re-resolved server-side: the client
 * never supplies a lead id, so a crafted request cannot retarget a token.
 */
export async function saveFollowUp(input: {
  token: string;
  subject: string;
  body: string;
}): Promise<SaveFollowUpResult> {
  await requireAuthenticatedUser();

  const subject = (input.subject ?? "").slice(0, MAX_SUBJECT);
  const body = (input.body ?? "").slice(0, MAX_BODY);

  if (!subject.trim()) return { ok: false, error: "A subject is required." };

  const result = await saveFollowUpDraft({
    rawToken: input.token,
    subject,
    body,
  });

  if (!result.ok || !result.data) {
    return { ok: false, error: result.error ?? INVALID_TOKEN_MESSAGE };
  }

  return { ok: true, savedAt: new Date().toISOString(), created: result.data.created };
}