import { normalizeEmail } from "@/lib/email";
import { toUtcIso } from "@/lib/followup/cadence";
import { createLead, getLead } from "@/lib/services/lead-service";
import { markFollowUpSent } from "@/lib/services/follow-up-service";
import {
  describeBlocked,
  evaluateStoredMessageQualityGate,
  type GateEvaluation,
} from "@/lib/services/outreach-quality-gate";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  Lead,
  OutreachMessage,
  OutreachHistoryRow,
  LeadOutreachEmail,
  OutreachKind,
  ServiceResult,
} from "@/lib/types";

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id";

/**
 * Filters for {@link listOutreachHistory}.
 */
interface OutreachHistoryFilters {
  status?: string | null;
  search?: string | null;
  limit?: number;
}

function fail(error: string): ServiceResult<never> {
  return { ok: false, data: null, error };
}

export interface DraftInput {
  recipientEmail: string;
  /** Main outreach (sequence 0) */
  mainSubject: string;
  mainBody: string;
  /** Follow-ups (sequence 1, 2, 3...) - optional, defaults to empty array */
  followUps?: Array<{ subject: string | null; body: string | null }>;
  /** @deprecated Use followUps instead. Single follow-up (sequence 1) for backward compatibility. */
  followUpSubject?: string | null;
  /** @deprecated Use followUps instead. Single follow-up (sequence 1) for backward compatibility. */
  followUpBody?: string | null;
  companyName?: string | null;
  contactName?: string | null;
  /** Set when re-saving an existing draft instead of creating a new one. */
  messageId?: string | null;
}

/** Save the composer's contents as a draft.
 *
 * The lead is created on demand (dedupe is guaranteed by the unique index on
 * `leads.email_normalized`), and re-saving the same recipient updates the open
 * draft rather than piling up duplicates — also enforced by a unique index on
 * (lead_id, normalized recipient_email).
 *
 * PEPA's outreach page always writes a MAIN (sequence 0) and one or more
 * FOLLOW-UPs (sequence 1, 2, 3...). Writing them as one unit means a
 * lead never ends up with an initial email and no follow-up, and each can
 * later be worked on, sent and scheduled independently.
 */
export async function createDraft(
  input: DraftInput,
): Promise<ServiceResult<{
  lead: Lead;
  main: OutreachMessage;
  followUp: OutreachMessage | null; // First follow-up (sequence 1) for backward compatibility
  followUps: OutreachMessage[];     // All follow-ups (sequence 1, 2, 3...)
  created: boolean;
}>> {
  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (!recipientEmail) return fail("A recipient email is required.");

  const supabase = getSupabaseAdmin();

  const leadPromise =
    input.messageId && input.messageId.startsWith("main_")
      ? getLead(await leadIdForMessage(input.messageId))
      : createLead({
          email: recipientEmail,
          companyName: input.companyName,
          contactName: input.contactName,
        });

  const leadResult = await leadPromise;

  if (!leadResult.ok || !leadResult.data) {
    return fail(leadResult.error ?? "Could not resolve the lead for this draft.");
  }
  const lead = leadResult.data;

  const mainPayload = {
    lead_id: lead.id,
    recipient_email: recipientEmail,
    subject: input.mainSubject.trim() || null,
    body: input.mainBody.trim() || null,
    status: "draft" as const,
    sequence_number: 0,
    parent_message_id: null,
  };

  let mainMessage: OutreachMessage;
  const followUpMessages: OutreachMessage[] = [];

  if (input.messageId && input.messageId.startsWith("main_")) {
    // Only persist the main draft this session asked for. Everything else
    // (including the paired follow-ups) is left alone unless it was written
    // below.
    const { data: updated, error: updateError } = await supabase
      .from("outreach_messages")
      .update(mainPayload)
      .eq("id", input.messageId.slice("main_".length))
      .select(MESSAGE_COLUMNS)
      .maybeSingle();

    if (updateError) return fail(updateError.message);
    if (!updated) return fail("Draft not found.");
    mainMessage = updated as OutreachMessage;
    return {
      ok: true,
      error: null,
      data: {
        lead,
        main: mainMessage,
        followUp: followUpMessages[0] ?? null,
        followUps: followUpMessages,
        created: false,
      },
    };
  }

  // ---- MAIN DRAFT -----------------------------------------------------
  const mainInsert = supabase
    .from("outreach_messages")
    .upsert(mainPayload, {
      onConflict: "lead_id,recipient_normalized,sequence_number",
      ignoreDuplicates: false,
    })
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  const mainResult = await mainInsert;
  if (!mainResult.data) {
    if (mainResult.error && mainResult.error.code === "23505") {
      return fail(
        "A draft for this recipient already exists. Open it from the history table instead.",
      );
    }
    return fail(mainResult.error?.message ?? "The main draft could not be saved.");
  }
  mainMessage = mainResult.data as OutreachMessage;

  // ---- FOLLOW-UP DRAFTS -----------------------------------------------
  // Build the list of follow-ups from both old and new APIs
  const followUpsInput: Array<{ subject: string | null; body: string | null }> = [];

  // New API: followUps array
  if (input.followUps && input.followUps.length > 0) {
    followUpsInput.push(...input.followUps);
  }
  // Old API: followUpSubject/followUpBody (for backward compatibility)
  // Only use if they have actual content (not null/undefined/empty)
  else if (
    (input.followUpSubject !== undefined && input.followUpSubject !== null && input.followUpSubject.trim() !== "") ||
    (input.followUpBody !== undefined && input.followUpBody !== null && input.followUpBody.trim() !== "")
  ) {
    followUpsInput.push({
      subject: input.followUpSubject ?? null,
      body: input.followUpBody ?? null,
    });
  }

  for (let i = 0; i < followUpsInput.length; i += 1) {
    const fu = followUpsInput[i]!;
    const sequenceNumber = i + 1;
    const followUpSubject = fu.subject?.trim() || null;
    const followUpBody = fu.body?.trim() || null;

    const followUpPayload = {
      lead_id: lead.id,
      recipient_email: recipientEmail,
      subject: followUpSubject,
      body: followUpBody,
      status: "draft" as const,
      sequence_number: sequenceNumber,
      parent_message_id: mainMessage.id,
    };

    const followUpInsert = supabase
      .from("outreach_messages")
      .upsert(followUpPayload, {
        onConflict: "lead_id,recipient_normalized,sequence_number",
        ignoreDuplicates: false,
      })
      .select(MESSAGE_COLUMNS)
      .maybeSingle();

    const followUpResult = await followUpInsert;
    if (!followUpResult.data) {
      if (followUpResult.error && followUpResult.error.code === "23505") {
        return fail(
          `A follow-up draft (sequence ${sequenceNumber}) for this recipient already exists. Open it from the history table instead.`,
        );
      }
      // If follow-up creation fails, we should clean up the main draft and any previously created follow-ups to maintain consistency
      await supabase
        .from("outreach_messages")
        .delete()
        .eq("id", mainMessage.id);
      for (const createdFu of followUpMessages) {
        await supabase
          .from("outreach_messages")
          .delete()
          .eq("id", createdFu.id);
      }
      return fail(
        followUpResult.error?.message ??
          `The follow-up draft (sequence ${sequenceNumber}) could not be saved.`,
      );
    }
    followUpMessages.push(followUpResult.data as OutreachMessage);
  }

  return {
    ok: true,
    error: null,
    data: {
      lead,
      main: mainMessage,
      followUp: followUpMessages[0] ?? null,
      followUps: followUpMessages,
      created: true,
    },
  };
}

async function leadIdForMessage(messageId: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outreach_messages")
    .select("lead_id")
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Draft not found.");
  return (data as { lead_id: string }).lead_id;
}

/**
 * A message may be recorded as sent only from these states.
 *
 * `replied` / `completed` / `blocked` are terminal: a conversation that already
 * moved on must not be dragged back to "sent". `follow_up` is excluded too —
 * it means a follow-up already went out and is handled by its own message.
 */
const SENDABLE_STATUSES = ["draft", "ready"] as const;

export type RecordSentResult =
  | {
      outcome: "recorded";
      main: OutreachMessage;
      followUp: OutreachMessage | null;
      nextFollowUpAt: string | null;
      gate: GateEvaluation | null;
    }
  | {
      outcome: "already_sent";
      main: OutreachMessage;
      followUp: OutreachMessage | null;
      gate: GateEvaluation | null;
    }
  | {
      outcome: "blocked";
      gate: GateEvaluation;
      error: string;
      blockReason: string | null;
    }
  | {
      outcome: "needs_confirmation";
      gate: GateEvaluation;
      error: string;
    };

/**
 * Record that the operator sent a draft from their own mail client.
 *
 * PEPA does not send email and has no provider: this only records a fact the
 * operator asserts, so that the follow-up engine can see that real outreach
 * happened. `provider` and `provider_message_id` are deliberately left NULL —
 * PEPA has no idea which client was used and will not invent a delivery id.
 *
 * Idempotency and concurrency come from the database, not from an application
 * flag. The UPDATE is a compare-and-set on two columns at once:
 *
 *   status IN ('draft','ready')  — only an unsent message can transition
 *   sent_at IS NULL              — a message already recorded as sent never
 *                                  transitions again, even if another code path
 *                                  put its status back to 'draft'
 *
 * Under Postgres row locking exactly one concurrent caller matches; the losers
 * match zero rows and fall through to the idempotent branch below. Only the
 * winner calls `markFollowUpSent()`, which is what keeps `followup_count` and
 * `next_followup_at` from being advanced twice.
 */
export async function recordOutreachSent(input: {
  messageId: string;
  leadId: string;
  sentAt?: Date;
  /** Set by the caller once the operator has explicitly acknowledged the gate's
   * warnings. Warnings are never waived implicitly: the first call reports them
   * and the second one, with this flag, proceeds.
   */
  confirmWarnings?: boolean;
}): Promise<ServiceResult<RecordSentResult>> {
  if (!input.messageId) return fail("A message is required.");
  if (!input.leadId) return fail("A lead is required.");

  const sentAt = input.sentAt ?? new Date();
  const supabase = getSupabaseAdmin();

  // The quality gate runs here, inside the send transition, rather than in the
  // action or the UI. That placement is the whole point: the draft is re-read
  // from Postgres and re-checked at the moment of the write, so a dashboard
  // loaded ten minutes ago — or a hand-crafted request that skips the UI
  // entirely — cannot talk the server into recording a blocked draft as sent.
  //
  // The gate consults `outreach_messages` AND `historical_outreach`, so this is
  // also the single point where imported legacy history stops a cold outreach.
  // Nothing above this function decides that; `requireAuthenticatedUser()`
  // proves who is asking, not whether the recipient may be contacted.
  const evaluated = await evaluateStoredMessageQualityGate(input.messageId, input.leadId);
  const gate = evaluated?.gate ?? null;

  if (evaluated && (evaluated.message.sent_at !== null || evaluated.message.status === "sent")) {
    // Already recorded. Idempotency outranks the gate: no write is about to
    // happen, so there is nothing for the gate to authorise, and reporting a
    // refusal here would misdescribe a send that legitimately succeeded earlier.
    return {
      ok: true,
      error: null,
      data: { outcome: "already_sent", main: evaluated.message, followUp: null, gate },
    };
  }

  if (gate?.status === "blocked") {
    return {
      ok: true,
      error: null,
      data: {
        outcome: "blocked",
        gate,
        error: describeBlocked(gate),
        // Surfaced rather than left inside the gate: a caller that has to
        // distinguish "already contacted" from every other refusal must not have
        // to re-parse prose to do it.
        blockReason: gate.blockReason ?? null,
      },
    };
  }

  if (gate?.status === "warning" && !input.confirmWarnings) {
    return {
      ok: true,
      error: null,
      data: {
        outcome: "needs_confirmation",
        gate,
        error: gate.reasons.join(" ") || "This draft has warnings to review.",
      },
    };
  }

  const { data, error } = await supabase
    .from("outreach_messages")
    .update({ status: "sent", sent_at: toUtcIso(sentAt) })
    .eq("id", input.messageId)
    // The message must belong to the lead the caller asked for, so a crafted
    // request cannot record a different lead's message as sent.
    .eq("lead_id", input.leadId)
    .in("status", [...SENDABLE_STATUSES])
    .is("sent_at", null)
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  if (error) return fail(error.message);

  if (!data) {
    // Zero rows matched. Either this exact message is already recorded as sent
    // (idempotent no-op), or the id/lead pair does not exist at all. The two
    // must not be conflated: a wrong lead id is a failure, not a success.
    const existing = await findRecordedSend(input.messageId, input.leadId);
    if (!existing) return fail("That message does not exist for this lead.");

    return {
      ok: true,
      error: null,
      data: { outcome: "already_sent", main: existing, followUp: null, gate: gate ?? null },
    };
  }

  // Sent state is durable at this point, so scheduling may begin.
  let nextFollowUpAt: string | null = null;
  try {
    const scheduled = await markFollowUpSent({ leadId: input.leadId, sentAt });
    nextFollowUpAt = scheduled.nextFollowUpAt;
  } catch {
    // The send record is the important half and it is already committed. Losing
    // the schedule is recoverable by re-recording; failing the whole action
    // would report a sent email as not sent.
    nextFollowUpAt = null;
  }

  return {
    ok: true,
    error: null,
    data: {
      outcome: "recorded",
      main: data as OutreachMessage,
      followUp: null,
      nextFollowUpAt,
      gate: gate ?? null,
    },
  };
}

/**
 * The already-recorded-sent message for this exact (message, lead) pair.
 *
 * Scoped to `sent_at IS NOT NULL` so a message that simply does not exist, or
 * exists under a different lead, is reported as "not found" rather than being
 * mistaken for an idempotent repeat.
 */
async function findRecordedSend(
  messageId: string,
  leadId: string,
): Promise<OutreachMessage | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", messageId)
    .eq("lead_id", leadId)
    .not("sent_at", "is", null)
    .maybeSingle();
  if (error) return null;
  return (data as OutreachMessage | null) ?? null;
}

/**
 * Every message ever attached to a lead, newest first.
 * Feeds reply/follow-up history (V2).
 */
export async function getLeadOutreachHistory(
  leadId: string,
): Promise<ServiceResult<OutreachMessage[]>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });

  if (error) return fail(error.message);
  return { ok: true, error: null, data: (data ?? []) as OutreachMessage[] };
}

/**
 * Load each lead's two outreach emails (main at sequence 0 and follow-up at
 * sequence 1, if stored). One query joins the messages, so a lead with two
 * drafts costs one round trip whether it owns one or both.
 *
 * Throws on a database error. The caller is responsible for handling it.
 */
async function leadOutreachEmails(
  leadIds: string[],
): Promise<Map<string, LeadOutreachEmail[]>> {
  if (leadIds.length === 0) return new Map();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .in("lead_id", leadIds)
    .order("lead_id", { ascending: true })
    .order("sequence_number", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const byLead = new Map<string, LeadOutreachEmail[]>();

  for (const row of (data ?? [])) {
    const leadId = String(row.lead_id);
    const message = {
      id: row.id,
      lead_id: leadId,
      recipient_email: row.recipient_email,
      subject: row.subject,
      body: row.body,
      status: row.status,
      provider: row.provider,
      provider_message_id: row.provider_message_id,
      sent_at: row.sent_at,
      created_at: row.created_at,
      sequence_number: Number(row.sequence_number ?? 0),
      parent_message_id: row.parent_message_id ?? null,
    } as OutreachMessage;

    const kind: OutreachKind =
      Number(message.sequence_number) === 0 ? "main" : "follow-up";

    const rowsForLead = byLead.get(leadId) ?? [];
    rowsForLead.push({ message, kind });
    byLead.set(leadId, rowsForLead);
  }

  return byLead;
}

/**
 * Rows for the dashboard table, joined with each lead's two outreach emails.
 */
export async function listOutreachHistory(
  filters: OutreachHistoryFilters = {},
): Promise<ServiceResult<OutreachHistoryRow[]>> {
  const supabase = getSupabaseAdmin();
  const leadQuery = supabase
    .from("outreach_overview")
    .select(
      "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count, latest_subject, latest_message_status, latest_message_at, message_count, last_followup_notified_number, last_followup_notified_at",
    )
    .order("updated_at", { ascending: false })
    .limit(filters.limit ?? 200);

  if (filters.status) leadQuery.eq("status", filters.status);
  if (filters.search) {
    const safe = filters.search.replace(/[%,()]/g, "");
    leadQuery.or(
      `email.ilike.%${safe}%,company_name.ilike.%${safe}%,contact_name.ilike.%${safe}%,latest_subject.ilike.%${safe}%`,
    );
  }

  const { data, error } = await leadQuery;
  if (error) return fail(error.message);

  const leadIds = (data ?? []).map((row) => row.id);

  // A lead that already has an initial email in the database is the one that
  // the operator will press "send" on, so the pair is read from the database
  // not assumed from the latest_subject.
  let emailsByLead: Map<string, LeadOutreachEmail[]>;
  try {
    emailsByLead = await leadOutreachEmails(leadIds);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not read the outreach emails.");
  }

  // The view returns snake_case; the UI works with the camelCase row type.
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    email: row.email as string,
    company_name: (row.company_name ?? null) as string | null,
    contact_name: (row.contact_name ?? null) as string | null,
    status: row.status as Lead["status"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    last_contacted_at: (row.last_contacted_at ?? null) as string | null,
    next_followup_at: (row.next_followup_at ?? null) as string | null,
    followup_count: Number(row.followup_count ?? 0),
    latestSubject: (row.latest_subject ?? null) as string | null,
    latestMessageStatus: (row.latest_message_status ?? null) as Lead["status"] | null,
    latestMessageAt: (row.latest_message_at ?? null) as string | null,
    messageCount: Number(row.message_count ?? 0),
    lastFollowupNotifiedNumber:
      row.last_followup_notified_number === null ||
      row.last_followup_notified_number === undefined
        ? null
        : Number(row.last_followup_notified_number),
    lastFollowupNotifiedAt: (row.last_followup_notified_at ?? null) as string | null,
  }));

  // A lead is an unsent draft only while its sequence head — the
  // sequence-0 outreach — is still unsent. The view exposes only the
  // NEWEST message per lead, so a lead whose primary went out and whose
  // follow-up is still a draft would otherwise look deletable here. The
  // heads are read separately and joined in.
  const primaryMessagesByLead = new Map<
    string,
    { status: string; sent_at: string | null } | null
  >();
  if (leadIds.length > 0) {
    const { data: primaryMessages } = await supabase
      .from("outreach_messages")
      .select("lead_id, status, sent_at")
      .eq("sequence_number", 0)
      .in("lead_id", leadIds);

    for (const message of (primaryMessages ?? [])) {
      primaryMessagesByLead.set(
        String(message.lead_id),
        { status: message.status, sent_at: message.sent_at },
      );
    }
  }

  const unsentByLead = new Map<string, boolean>(
    leadIds.map((leadId) => [leadId, true]),
  );
  for (const [leadId, primary] of primaryMessagesByLead) {
    if (primary) {
      unsentByLead.set(
        leadId,
        primary.sent_at === null &&
          (primary.status === "draft" || primary.status === "ready"),
      );
    }
  }

  return {
    ok: true,
    error: null,
    data: rows.map((row) => ({
      ...row,
      mainEmail: emailsByLead.get(row.id)?.find((entry) => entry.kind === "main") ?? null,
      followUpEmail: emailsByLead.get(row.id)?.find((entry) => entry.kind === "follow-up") ?? null,
      unsent: unsentByLead.get(row.id) ?? true,
    })),
  };
}
