"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import {
  INVALID_TOKEN_MESSAGE,
  saveFollowUpDraft,
} from "@/lib/services/action-token-service";
import {
  createFollowUpDraft,
  type FollowUpFailure,
} from "@/lib/services/follow-up-sequence-service";

export type SaveFollowUpResult =
  | { ok: true; savedAt: string; created: boolean }
  | { ok: false; error: string };

export type CreateFollowUpResult =
  | { ok: true; created: boolean; messageId: string; sequenceNumber: number }
  | { ok: false; error: string; reason: FollowUpFailure | "invalid_input" };

const MAX_SUBJECT = 998;
const MAX_BODY = 200_000;

/**
 * A message id is a uuid. Validating the shape here means a malformed value is
 * refused at the door instead of becoming a pointless round trip; the id is
 * still resolved authoritatively from the database by the service.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 8F — create the next follow-up in a sequence, from the session.
 *
 * Before this existed, the only way to obtain a follow-up composer token was as
 * a side effect of the due-follow-up scheduler notifying the operator on
 * Telegram. Writing a follow-up therefore required sending a notification
 * first, which made "draft the follow-up now, notify later" impossible and
 * coupled an authoring action to a delivery channel.
 *
 * This action breaks that coupling by reusing `createFollowUpDraft()` — the
 * sequence service that already owns eligibility, slot allocation, the parent
 * relationship and duplicate/concurrency handling. No sequence logic is
 * reimplemented here, and this is deliberately NOT a second implementation of
 * follow-up creation: it is the same function the Telegram path's deep link
 * ultimately lands on.
 *
 * What it deliberately does NOT do:
 *   * mint any action token;
 *   * call the Telegram provider, or any notification transport;
 *   * write to `followup_notifications`, the ledger, or the cron schedule.
 *
 * So creating a draft here notifies nobody. The notification engine and the
 * ledger are untouched, and the operator is still pinged by the scheduler when a
 * follow-up is actually due.
 *
 * Authorization and identity:
 *   * `requireAuthenticatedUser()` runs first and throws before anything else —
 *     the same guard every other mutation in PEPA uses. `verifySession()` is
 *     deliberately not used here: it is the page guard that *redirects*, and a
 *     redirect from a server action is not a way to reject a write.
 *   * the client sends a parent message id and nothing else. Lead, recipient,
 *     sequence number and the parent row itself are all resolved from the
 *     database by the service, so a crafted request cannot retarget a lead or
 *     invent a recipient.
 *
 * Not a public endpoint: server actions are POST-only, session-gated and carry
 * no token in any URL.
 */
export async function createFollowUp(input: {
  parentMessageId: string;
  subject: string;
  body: string;
}): Promise<CreateFollowUpResult> {
  await requireAuthenticatedUser();

  const parentMessageId = typeof input.parentMessageId === "string" ? input.parentMessageId.trim() : "";
  if (!UUID.test(parentMessageId)) {
    return { ok: false, error: "That message could not be found.", reason: "invalid_input" };
  }

  const subject = (typeof input.subject === "string" ? input.subject : "")
    .slice(0, MAX_SUBJECT)
    .trim();
  if (!subject) return { ok: false, error: "A subject is required.", reason: "invalid_input" };

  const body = (typeof input.body === "string" ? input.body : "").slice(0, MAX_BODY);

  const result = await createFollowUpDraft({ anchorMessageId: parentMessageId, subject, body });

  if (!result.ok || !result.data) {
    return {
      ok: false,
      error: result.error ?? "The follow-up could not be saved.",
      reason: result.reason ?? "store_failed",
    };
  }

  return {
    ok: true,
    created: result.data.created,
    messageId: result.data.message.id,
    sequenceNumber: result.data.message.sequence_number,
  };
}

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