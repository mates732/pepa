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
import type { Lead, OutreachHistoryRow, OutreachMessage, ServiceResult } from "@/lib/types";

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at";

function fail(error: string): ServiceResult<never> {
  return { ok: false, data: null, error };
}

export interface DraftInput {
  recipientEmail: string;
  subject: string;
  body: string;
  companyName?: string | null;
  contactName?: string | null;
  /** Set when re-saving an existing draft instead of creating a new one. */
  messageId?: string | null;
}

/**
 * Save the composer's contents as a draft.
 *
 * The lead is created on demand (dedupe is guaranteed by the unique index on
 * `leads.email_normalized`), and re-saving the same recipient updates the open
 * draft rather than piling up duplicates — also enforced by a unique index on
 * (lead_id, normalized recipient_email).
 */
export async function createDraft(
  input: DraftInput,
): Promise<ServiceResult<{ lead: Lead; message: OutreachMessage; created: boolean }>> {
  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (!recipientEmail) return fail("A recipient email is required.");

  const leadResult = input.messageId
    ? await getLead(await leadIdForMessage(input.messageId))
    : await createLead({
        email: recipientEmail,
        companyName: input.companyName,
        contactName: input.contactName,
      });

  if (!leadResult.ok || !leadResult.data) {
    return fail(leadResult.error ?? "Could not resolve the lead for this draft.");
  }
  const lead = leadResult.data;

  const supabase = getSupabaseAdmin();
  const payload = {
    lead_id: lead.id,
    recipient_email: recipientEmail,
    subject: input.subject.trim() || null,
    body: input.body.trim() || null,
    status: "draft" as const,
  };

  if (input.messageId) {
    const { data, error } = await supabase
      .from("outreach_messages")
      .update(payload)
      .eq("id", input.messageId)
      .select(MESSAGE_COLUMNS)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!data) return fail("Draft not found.");
    return { ok: true, error: null, data: { lead, message: data as OutreachMessage, created: false } };
  }

  const { data, error } = await supabase
    .from("outreach_messages")
    .upsert(payload, {
      onConflict: "lead_id,recipient_normalized",
      ignoreDuplicates: false,
    })
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("An outreach message for this recipient already exists. Open it from the history table instead.");
    }
    return fail(error.message);
  }
  if (!data) return fail("Draft could not be saved.");

  return { ok: true, error: null, data: { lead, message: data as OutreachMessage, created: true } };
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
  /** The transition happened on this call, and a follow-up was scheduled. */
  | {
      outcome: "recorded";
      message: OutreachMessage;
      nextFollowUpAt: string | null;
      gate: GateEvaluation | null;
    }
  /** It was already recorded as sent. Nothing was written, nothing rescheduled. */
  | { outcome: "already_sent"; message: OutreachMessage; gate: GateEvaluation | null }
  /** The quality gate refused. Nothing was written. */
  | { outcome: "blocked"; gate: GateEvaluation; error: string }
  /** Warnings are present and the operator has not confirmed them yet. */
  | { outcome: "needs_confirmation"; gate: GateEvaluation; error: string };

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
  /**
   * Set by the caller once the operator has explicitly acknowledged the gate's
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
  const evaluated = await evaluateStoredMessageQualityGate(input.messageId, input.leadId);
  const gate = evaluated?.gate ?? null;

  if (evaluated && (evaluated.message.sent_at !== null || evaluated.message.status === "sent")) {
    // Already recorded. Idempotency outranks the gate: no write is about to
    // happen, so there is nothing for the gate to authorise, and reporting a
    // refusal here would misdescribe a send that legitimately succeeded earlier.
    return {
      ok: true,
      error: null,
      data: { outcome: "already_sent", message: evaluated.message, gate },
    };
  }

  if (gate?.status === "blocked") {
    return {
      ok: true,
      error: null,
      data: { outcome: "blocked", gate, error: describeBlocked(gate) },
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
      data: { outcome: "already_sent", message: existing, gate: gate ?? null },
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
      message: data as OutreachMessage,
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

/** Every message ever attached to a lead, newest first. Feeds reply/follow-up history (V2). */
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

export interface OutreachHistoryFilters {
  status?: string | null;
  search?: string | null;
  limit?: number;
}

/** Rows for the dashboard table, joined with each lead's latest message. */
export async function listOutreachHistory(
  filters: OutreachHistoryFilters = {},
): Promise<ServiceResult<OutreachHistoryRow[]>> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("outreach_overview")
    .select(
      "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count, latest_subject, latest_message_status, latest_message_at, message_count, last_followup_notified_number, last_followup_notified_at",
    )
    .order("updated_at", { ascending: false })
    .limit(filters.limit ?? 200);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.search) {
    const safe = filters.search.replace(/[%,()]/g, "");
    query = query.or(
      `email.ilike.%${safe}%,company_name.ilike.%${safe}%,contact_name.ilike.%${safe}%,latest_subject.ilike.%${safe}%`,
    );
  }

  const { data, error } = await query;
  if (error) return fail(error.message);

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
      row.last_followup_notified_number === null || row.last_followup_notified_number === undefined
        ? null
        : Number(row.last_followup_notified_number),
    lastFollowupNotifiedAt: (row.last_followup_notified_at ?? null) as string | null,
  }));

  return { ok: true, error: null, data: rows };
}