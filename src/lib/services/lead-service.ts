import { isValidEmail, normalizeEmail } from "@/lib/email";
import { findHistoricalContact } from "@/lib/services/historical-outreach-service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  ALREADY_CONTACTED,
  ALREADY_CONTACTED_DOMAIN,
  type DuplicateCheckResult,
  type HistoricalContact,
  type Lead,
  type OutreachBlockReason,
  type ServiceResult,
} from "@/lib/types";

type LeadWithMessages = Lead & {
  outreach_messages: Array<{
    id: string;
    status: string;
    sent_at: string | null;
    created_at: string;
  }>;
};

/** A message only counts as real outreach once it left the outbox. */
const CONTACTED_STATUSES = new Set(["sent", "follow_up", "replied"]);

/**
 * The lead-pipeline answer to "may this address be contacted at all?".
 *
 * One place, so the composer's badge, the gate and any future lead discovery
 * path cannot disagree. Only a PERMANENT refusal sets `canContact: false`: the
 * finite cooldown is a property of the send transition, which is the only place
 * that can enforce it, and reporting it here would describe a rule this read
 * path does not apply.
 */
function contactability(historicalContact: HistoricalContact | null): {
  canContact: boolean;
  blockReason: OutreachBlockReason | null;
} {
  if (!historicalContact) return { canContact: true, blockReason: null };
  return {
    canContact: false,
    blockReason:
      historicalContact.matchedOn === "domain" ? ALREADY_CONTACTED_DOMAIN : ALREADY_CONTACTED,
  };
}

function fail(error: string): ServiceResult<never> {
  return { ok: false, data: null, error };
}

/**
 * Look a lead up by (normalized) email and describe its outreach history.
 * This is the single source of truth behind the duplicate badge in the UI.
 *
 * It answers two questions that are easy to conflate:
 *
 *   * Does PEPA have a LEAD for this address, and what has Pepa done on it?
 *     (`state`, `messageCount`, `sentCount`, `lastContactedAt`)
 *   * Is the address already on record from the LEGACY account, so no new cold
 *     outreach may start? (`historicalContact`, `canContact`, `blockReason`)
 *
 * The second question is asked even when there is no lead row at all. That case
 * is the common one after a historical import — hundreds of addresses the
 * previous account pitched that PEPA has never seen — and answering it from the
 * `leads` table alone would report every one of them as "new".
 */
export async function findLeadByEmail(
  rawEmail: string,
): Promise<ServiceResult<DuplicateCheckResult>> {
  const normalizedEmail = normalizeEmail(rawEmail);
  if (!normalizedEmail) {
    return fail("No recipient email to check.");
  }
  if (!isValidEmail(normalizedEmail)) {
    return fail(`"${normalizedEmail}" is not a valid email address.`);
  }

  // Resolved before the lead lookup so an unreadable historical table surfaces
  // as a failure rather than as a clean "new lead". This is the read path
  // behind the composer's badge, and a badge that lies is worse than an error.
  const historicalContact = await findHistoricalContact(normalizedEmail);
  const { canContact, blockReason } = contactability(historicalContact);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count, outreach_messages(id, status, sent_at, created_at)",
    )
    .eq("email_normalized", normalizedEmail)
    .maybeSingle();

  if (error) return fail(error.message);

  // A legacy hit outranks a bare lead row: an address the previous account
  // pitched has been contacted, whatever PEPA's own lead status happens to be.
  const lastContactedAt =
    (data as LeadWithMessages | null)?.last_contacted_at ??
    historicalContact?.lastContactAt ??
    null;

  if (!data) {
    return {
      ok: true,
      error: null,
      data: {
        state: historicalContact ? "contacted" : "new",
        normalizedEmail,
        lead: null,
        messageCount: 0,
        sentCount: 0,
        lastContactedAt,
        historicalContact,
        canContact,
        blockReason,
      },
    };
  }

  const row = data as LeadWithMessages;
  const { outreach_messages: messages, ...lead } = row;
  const sent = messages.filter(
    (m) => m.sent_at !== null || CONTACTED_STATUSES.has(m.status),
  );
  const latestSentAt = sent.reduce<string | null>(
    (latest, m) => (m.sent_at && (!latest || m.sent_at > latest) ? m.sent_at : latest),
    null,
  );

  return {
    ok: true,
    error: null,
    data: {
      state: lastContactedAt ? "contacted" : "existing",
      normalizedEmail,
      lead: lead as Lead,
      messageCount: messages.length,
      sentCount: sent.length,
      // The lead's own timestamp stays authoritative; a historical contact is a
      // fallback for an address Pepa has never touched.
      lastContactedAt: lead.last_contacted_at ?? latestSentAt ?? historicalContact?.lastContactAt ?? null,
      historicalContact,
      canContact,
      blockReason,
    },
  };
}

/**
 * Create a lead, or return the existing one for the same normalized email.
 * Uses an upsert with `ignoreDuplicates` so the database's unique index — not
 * an application-side check — resolves the race between two rapid pastes.
 */
export async function createLead(input: {
  email: string;
  companyName?: string | null;
  contactName?: string | null;
}): Promise<ServiceResult<Lead>> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return fail(`"${input.email}" is not a valid email address.`);
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("leads").upsert(
    [
      {
        email,
        company_name: input.companyName?.trim() || null,
        contact_name: input.contactName?.trim() || null,
      },
    ],
    { onConflict: "email_normalized", ignoreDuplicates: true },
  );
  if (error) return fail(error.message);

  const { data, error: readError } = await supabase
    .from("leads")
    .select(
      "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count",
    )
    .eq("email_normalized", email)
    .maybeSingle();

  if (readError) return fail(readError.message);
  if (!data) return fail("Lead could not be read back after creation.");

  return { ok: true, error: null, data: data as Lead };
}

export async function getLead(leadId: string): Promise<ServiceResult<Lead>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count",
    )
    .eq("id", leadId)
    .maybeSingle();

  if (error) return fail(error.message);
  if (!data) return fail("Lead not found.");
  return { ok: true, error: null, data: data as Lead };
}

export async function setLeadStatus(
  leadId: string,
  status: Lead["status"],
): Promise<ServiceResult<Lead>> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("leads").update({ status }).eq("id", leadId);
  if (error) return fail(error.message);
  return getLead(leadId);
}

/**
 * The single-id cascade delete, shared by every deletion path.
 *
 * `leads` is the parent of every related row — `outreach_messages`,
 * `followup_notifications` and `action_tokens` all cascade — so one
 * DELETE naming a single id removes the lead together with its
 * messages (drafts and sent) and its pending follow-ups, and nothing
 * else: the WHERE clause names one id, so no other lead is touched.
 *
 * Carrying no status condition at all is deliberate: whether a lead
 * MAY be deleted is decided by the caller — `deleteUnsentLead`
 * refuses sent leads, `deleteLead` does not — but the blast radius
 * is identical in both cases.
 */
async function deleteLeadRow(
  leadId: string,
): Promise<ServiceResult<{ deleted: boolean }>> {
  const supabase = getSupabaseAdmin();
  const { error: deleteError, count } = await supabase
    .from("leads")
    .delete({ count: "exact" })
    .eq("id", leadId);

  if (deleteError) return fail(deleteError.message);
  if (!count) return fail("That lead does not exist.");

  return { ok: true, error: null, data: { deleted: true } };
}

/**
 * Delete a lead that has never been sent to.
 *
 * Only a lead whose primary outreach — the sequence-0 message — is
 * still an unsent draft may be deleted. Once the primary carries a
 * `sent_at` stamp or has moved past the draft statuses, the lead is
 * history: its outreach history, send time, follow-up cadence and
 * follow-up history have to survive, so deletion is refused instead.
 *
 * The actual removal is the shared `deleteLeadRow` cascade — see its
 * doc comment for why one delete removes the lead, its primary draft
 * and every pending follow-up, and nothing else.
 */
export async function deleteUnsentLead(
  leadId: string,
): Promise<ServiceResult<{ deleted: boolean }>> {
  if (!leadId) return fail("A lead is required.");

  const supabase = getSupabaseAdmin();

  // Read the sequence head, if one exists. A lead with no outreach at
  // all has never been sent to and is deletable.
  const { data: primary, error: readError } = await supabase
    .from("outreach_messages")
    .select("status, sent_at")
    .eq("lead_id", leadId)
    .eq("sequence_number", 0)
    .maybeSingle();

  if (readError) return fail(readError.message);

  const hasBeenSent =
    primary !== null &&
    (primary.sent_at !== null ||
      (primary.status !== "draft" && primary.status !== "ready"));

  // `primary` is narrowed above; the message row, when present, always carries
  // both columns because the query selected them.

  if (hasBeenSent) {
    return fail(
      "This lead has already been sent outreach. Its history is kept and it cannot be deleted.",
    );
  }

  return deleteLeadRow(leadId);
}

/**
 * Delete a lead from history and the database — sent or unsent.
 *
 * The server half of the history table's "Smazat z historie" control,
 * which is shown on every row. Unlike `deleteUnsentLead` this path
 * deliberately has NO sent guard: the operator has confirmed a dialog
 * that says the removal is permanent, and the specification for this
 * action explicitly includes sent leads.
 *
 * Everything else is the same shared cascade `deleteUnsentLead` uses
 * after its guard, so both paths have one delete and one blast radius.
 */
export async function deleteLead(
  leadId: string,
): Promise<ServiceResult<{ deleted: boolean }>> {
  if (!leadId) return fail("A lead is required.");
  return deleteLeadRow(leadId);
}

/**
 * Delete a single outreach message by ID.
 *
 * If the message is a main outreach (sequence 0), any follow-up
 * (sequence 1) with parent_message_id pointing to it will have its
 * parent_message_id set to NULL to avoid orphaned references.
 *
 * If the message is a follow-up (sequence 1), it is simply deleted.
 *
 * The caller must ensure the message exists before calling this function.
 */
export async function deleteOutreachMessage(
  messageId: string,
): Promise<ServiceResult<{ deleted: boolean }>> {
  if (!messageId) return fail("A message ID is required.");

  const supabase = getSupabaseAdmin();

  // First, read the message to know its sequence_number and lead_id
  const { data: message, error: readError } = await supabase
    .from("outreach_messages")
    .select("id, lead_id, sequence_number, parent_message_id")
    .eq("id", messageId)
    .maybeSingle();

  if (readError) return fail(readError.message);
  if (!message) return fail("That outreach message does not exist.");

  const leadId = message.lead_id;
  const sequenceNumber = Number(message.sequence_number ?? 0);

  // If this is a main message (sequence 0), find and update any follow-up
  // that references it as parent to set parent_message_id to NULL
  if (sequenceNumber === 0) {
    const { error: updateError } = await supabase
      .from("outreach_messages")
      .update({ parent_message_id: null })
      .eq("lead_id", leadId)
      .eq("sequence_number", 1)
      .eq("parent_message_id", messageId);

    if (updateError) return fail(updateError.message);
  }

  // Delete the message
  const { error: deleteError, count } = await supabase
    .from("outreach_messages")
    .delete({ count: "exact" })
    .eq("id", messageId);

  if (deleteError) return fail(deleteError.message);
  if (!count) return fail("That outreach message could not be deleted.");

  return { ok: true, error: null, data: { deleted: true } };
}