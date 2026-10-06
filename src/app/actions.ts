"use server";

import { revalidatePath } from "next/cache";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { buildGmailComposeUrl } from "@/lib/outreach/gmail-compose";
import {
  findLeadByEmail,
  deleteLead as deleteLeadService,
  deleteUnsentLead as deleteUnsentLeadService,
} from "@/lib/services/lead-service";
import {
  createDraft,
  listOutreachHistory,
  recordOutreachSent as recordOutreachSentService,
} from "@/lib/services/outreach-service";
import { evaluateDraftQualityGate, type GateEvaluation } from "@/lib/services/outreach-quality-gate";
import {
  getFollowUpDetail,
  listFollowUps,
  type FollowUpDetail,
  type FollowUpListItem,
} from "@/lib/services/follow-up-sequence-service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  DuplicateCheckResult,
  Lead,
  OutreachHistoryRow,
  OutreachMessage,
} from "@/lib/types";

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
 * so the badge always reflects what is actually stored — including the imported
 * legacy history in `historical_outreach`, which is what makes the badge
 * meaningful for an address PEPA has never sent to itself.
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
      /** The verdict that authorised the write, for the UI to render. */
      gate: GateEvaluation | null;
    }
  /**
   * The quality gate refused. `requiresConfirmation` separates the two
   * refusals: a blocked draft can never proceed, while a warning is waiting
   * for the operator to acknowledge it and submit again.
   */
  | {
      ok: false;
      error: string;
      outcome: "blocked" | "needs_confirmation";
      requiresConfirmation: boolean;
      gate: GateEvaluation;
      /**
       * Machine reason behind a refusal, e.g. `ALREADY_CONTACTED`. Null unless
       * the gate named one. The UI uses it to say why; it never uses it to
       * decide anything, because this action is not the enforcement point.
       */
      blockReason?: string | null;
    }
  | ActionFailure;

export type CheckQualityGateResult =
  | { ok: true; gate: GateEvaluation }
  | ActionFailure;

export type OpenInGmailResult =
  | { ok: true; url: string; sequenceNumber: number; isFollowUp: boolean }
  | ActionFailure;

/**
 * Build a Gmail compose URL for a stored outreach message.
 *
 * This action READS and returns a URL. It performs no send, sets no `sent_at`,
 * touches no status, and increments no counter. Opening Gmail is not sending:
 * only the explicit `recordOutreachSent()` below creates the sent state.
 *
 * The recipient, subject and body are resolved from the database row, never from
 * the client. The browser sends a message id and nothing else, so it cannot
 * redirect a draft at a different address or smuggle in its own content — the
 * values Gmail receives are exactly what PEPA stored.
 */
export async function openOutreachInGmail(messageId: string): Promise<OpenInGmailResult> {
  await requireAuthenticatedUser();

  if (!messageId || !UUID_PATTERN.test(messageId)) {
    return failure("That message could not be identified.");
  }

  try {
    const { data, error } = await getSupabaseAdmin()
      .from("outreach_messages")
      .select("id, lead_id, recipient_email, subject, body, sequence_number")
      .eq("id", messageId)
      .maybeSingle();

    if (error) return failure("That message could not be opened.");
    if (!data) return failure("That message does not exist.");

    // The message must belong to a lead that actually exists, otherwise the
    // operator could compose to an orphaned row.
    const { data: lead } = await getSupabaseAdmin()
      .from("leads")
      .select("id")
      .eq("id", String((data as { lead_id: unknown }).lead_id))
      .maybeSingle();
    if (!lead) return failure("That message has no lead.");

    const row = data as {
      recipient_email: string;
      subject: string | null;
      body: string | null;
      sequence_number: number | null;
    };
    const sequenceNumber = Number(row.sequence_number ?? 0);

    return {
      ok: true,
      url: buildGmailComposeUrl({
        to: row.recipient_email,
        subject: row.subject,
        body: row.body,
      }),
      sequenceNumber,
      isFollowUp: sequenceNumber > 0,
    };
  } catch {
    // Never surface a raw database error to the browser.
    return failure("That message could not be opened.");
  }
}

export type FollowUpWorkspaceResult =
  | { ok: true; followUps: FollowUpListItem[]; error: null }
  | ActionFailure;

export type FollowUpDetailResult =
  | { ok: true; detail: FollowUpDetail; error: null }
  | ActionFailure;

/**
 * Load the Follow-ups workspace.
 *
 * A server action rather than a client fetch so the sequence rules stay on the
 * server: the browser receives already-ordered rows and never issues its own
 * Supabase query. It is read-only — opening the workspace records nothing.
 */
export async function loadFollowUpWorkspace(): Promise<FollowUpWorkspaceResult> {
  await requireAuthenticatedUser();

  try {
    const result = await listFollowUps();
    if (!result.ok || !result.data) {
      return failure(result.error ?? "Follow-ups could not be loaded.");
    }
    return { ok: true, followUps: result.data, error: null };
  } catch {
    return failure("Follow-ups could not be loaded.");
  }
}

/**
 * Load one follow-up's detail, including its position in the sequence.
 *
 * The message id is the only input: lead, recipient, subject, body and sequence
 * position all come from the database, so a crafted id cannot redirect the view
 * onto content the caller did not already have access to.
 */
export async function loadFollowUpDetail(messageId: string): Promise<FollowUpDetailResult> {
  await requireAuthenticatedUser();

  if (!messageId || !UUID_PATTERN.test(messageId)) {
    return failure("That follow-up could not be identified.");
  }

  try {
    const result = await getFollowUpDetail(messageId);
    if (!result.ok || !result.data) {
      return failure(result.error ?? "That follow-up could not be loaded.");
    }
    return { ok: true, detail: result.data, error: null };
  } catch {
    return failure("That follow-up could not be loaded.");
  }
}

/**
 * Phase 8F follow-up entry: open the sequence detail for a lead's initial
 * outreach.
 *
 * The gap this closes. The Follow-ups workspace lists only `sequence_number > 0`,
 * so a lead whose newest row is the sequence-0 draft had no way to reach a
 * follow-up detail — and the detail is where the "Next follow-up" form lives.
 * The other routes in were the Telegram notification deep link and the
 * mark-as-sent path, both of which require an action this operator may not
 * always want to take just to draft the next email. So the very first follow-up
 * in a sequence was unreachable from the UI.
 *
 * This is read-only. It resolves nothing from the client: the browser sends a
 * lead id and the database decides which row that lead's sequence head is. The
 * resolved message id is then handed to the ordinary `getFollowUpDetail()`,
 * which is the same service the workspace uses — the detail rendering, the
 * chain, `unrecordedHistory` and every other rule are unchanged and not
 * reimplemented here.
 *
 * Nothing is fabricated. A lead with no stored sequence-0 row gets a plain
 * failure, never a placeholder detail, and no row is written by this action.
 */
export async function loadInitialOutreachDetail(input: {
  leadId: string;
}): Promise<FollowUpDetailResult> {
  await requireAuthenticatedUser();

  const leadId = typeof input.leadId === "string" ? input.leadId.trim() : "";
  if (!UUID_PATTERN.test(leadId)) {
    return failure("That lead could not be identified.");
  }

  let messageId: string;
  try {
    // DB-authoritative: the browser cannot name the message, only the lead.
    const { data, error } = await getSupabaseAdmin()
      .from("outreach_messages")
      .select("id")
      .eq("lead_id", leadId)
      .eq("sequence_number", 0)
      .maybeSingle();

    if (error) return failure("That initial outreach could not be loaded.");
    if (!data) return failure("That lead has no initial outreach stored yet.");
    messageId = String((data as { id: unknown }).id);
  } catch {
    return failure("That initial outreach could not be loaded.");
  }

  if (!UUID_PATTERN.test(messageId)) {
    return failure("That initial outreach could not be loaded.");
  }

  // Reuse the existing loader rather than assembling a detail here.
  return loadFollowUpDetail(messageId);
}

/**
 * Live, advisory quality-gate evaluation for the draft in the composer.
 *
 * Never authorises anything on its own: the send path re-runs the gate against
 * stored state, so this exists purely to tell the operator what will happen
 * before they click.
 */
export async function checkQualityGate(input: {
  recipient: string;
  subject: string;
  body: string;
  messageId?: string | null;
  leadId?: string | null;
}): Promise<CheckQualityGateResult> {
  await requireAuthenticatedUser();

  try {
    const gate = await evaluateDraftQualityGate({
      recipient: String(input?.recipient ?? ""),
      subject: String(input?.subject ?? ""),
      body: String(input?.body ?? ""),
      messageId: input?.messageId ?? null,
      leadId: input?.leadId ?? null,
    });
    return { ok: true, gate };
  } catch {
    // A gate failure must not read as "ready".
    return failure("The quality gate could not be evaluated.");
  }
}

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
  /** Second and later attempts, after the operator acknowledged warnings. */
  confirmWarnings?: boolean;
}): Promise<RecordOutreachSentResult> {
  await requireAuthenticatedUser();

  const messageId = String(input?.messageId ?? "");
  const leadId = String(input?.leadId ?? "");

  if (!UUID_PATTERN.test(messageId)) return failure("That message could not be identified.");
  if (!UUID_PATTERN.test(leadId)) return failure("That lead could not be identified.");

  try {
    const result = await recordOutreachSentService({
      messageId,
      leadId,
      confirmWarnings: input?.confirmWarnings === true,
    });
    if (!result.ok || !result.data) {
      return failure(result.error ?? "Could not record the send.");
    }

    const data = result.data;

    // A refusal must not reach the dashboard as a success, and must not
    // revalidate the page into a state the operator never achieved.
    if (data.outcome === "blocked" || data.outcome === "needs_confirmation") {
      return {
        ok: false,
        outcome: data.outcome,
        requiresConfirmation: data.outcome === "needs_confirmation",
        error: data.error,
        gate: data.gate,
        // Only a refusal carries a reason; a warning waiting for confirmation
        // has none, and reporting null there is honest rather than a guess.
        blockReason: data.outcome === "blocked" ? data.blockReason : null,
      };
    }

    revalidatePath("/");
    return {
      ok: true,
      outcome: data.outcome,
      message: data.message,
      // An idempotent repeat has no new schedule, so it never claims one.
      nextFollowUpAt: data.outcome === "recorded" ? data.nextFollowUpAt : null,
      gate: data.gate,
    };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Could not record the send.",
    );
  }
}

export type DeleteLeadResult = { ok: true; deleted: true } | ActionFailure;

/**
 * Remove a lead that has never been sent to.
 *
 * The service layer refuses any lead whose primary outreach has
 * left the outbox, so a sent lead's history — outreach history,
 * send time, follow-up cadence and follow-up history — is kept.
 * Deleting an unsent lead cascades to its primary draft and every
 * pending follow-up in its sequence, and touches nothing else.
 */
export async function deleteUnsentLead(input: {
  leadId: string;
}): Promise<DeleteLeadResult> {
  await requireAuthenticatedUser();

  const leadId = String(input?.leadId ?? "");
  if (!UUID_PATTERN.test(leadId)) {
    return failure("That lead could not be identified.");
  }

  try {
    const result = await deleteUnsentLeadService(leadId);
    if (!result.ok || !result.data) {
      return failure(result.error ?? "The lead could not be deleted.");
    }

    revalidatePath("/");
    return { ok: true, deleted: true };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "The lead could not be deleted.",
    );
  }
}

export type HistoryRowsResult =
  | { ok: true; rows: OutreachHistoryRow[] }
  | ActionFailure;

/**
 * Re-read the outreach history rows, server-side.
 *
 * The dashboard is a client component and must NOT import the service that
 * reads Postgres: that module carries `server-only` and would pull it into the
 * browser bundle (exactly what a production build refuses). This action is the
 * only way the client can refresh the table — after a draft is saved, the
 * edited lead's row is re-read so the table cannot keep showing what the page
 * rendered minutes ago.
 */
export async function loadHistoryRows(): Promise<HistoryRowsResult> {
  await requireAuthenticatedUser();

  try {
    const result = await listOutreachHistory();
    if (!result.ok) {
      return failure(result.error ?? "Could not read the outreach history.");
    }
    return { ok: true, rows: result.data ?? [] };
  } catch (error) {
    return failure(
      error instanceof Error
        ? error.message
        : "Could not read the outreach history.",
    );
  }
}

/**
 * Remove a lead from history and the database — sent or unsent.
 *
 * Server half of the history table's "Smazat z historie" control, which every
 * row shows. Unlike `deleteUnsentLead` this action carries no sent guard: the
 * operator has confirmed a dialog stating the removal is permanent, and the
 * specification for this action explicitly includes sent leads.
 *
 * The cascade stays the database's — one single-id delete (shared with
 * `deleteUnsentLead`) pulls the lead, its outreach messages (drafts and sent)
 * and its pending follow-ups, and touches no other lead.
 */
export async function deleteLeadFromHistory(input: {
  leadId: string;
}): Promise<DeleteLeadResult> {
  await requireAuthenticatedUser();

  const leadId = String(input?.leadId ?? "");
  if (!UUID_PATTERN.test(leadId)) {
    return failure("That lead could not be identified.");
  }

  try {
    const result = await deleteLeadService(leadId);
    if (!result.ok || !result.data) {
      return failure(result.error ?? "The lead could not be deleted.");
    }

    revalidatePath("/");
    return { ok: true, deleted: true };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "The lead could not be deleted.",
    );
  }
}