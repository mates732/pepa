import { normalizeEmail } from "@/lib/email";
import { createLead, getLead } from "@/lib/services/lead-service";
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