"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { saveImportedDraft } from "@/lib/services/import-service";

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