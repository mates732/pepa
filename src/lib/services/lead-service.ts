import { isValidEmail, normalizeEmail } from "@/lib/email";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { DuplicateCheckResult, Lead, ServiceResult } from "@/lib/types";

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

function fail(error: string): ServiceResult<never> {
  return { ok: false, data: null, error };
}

/**
 * Look a lead up by (normalized) email and describe its outreach history.
 * This is the single source of truth behind the duplicate badge in the UI.
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

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count, outreach_messages(id, status, sent_at, created_at)",
    )
    .eq("email_normalized", normalizedEmail)
    .maybeSingle();

  if (error) return fail(error.message);
  if (!data) {
    return {
      ok: true,
      error: null,
      data: {
        state: "new",
        normalizedEmail,
        lead: null,
        messageCount: 0,
        sentCount: 0,
        lastContactedAt: null,
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
  const lastContactedAt = lead.last_contacted_at ?? latestSentAt;

  return {
    ok: true,
    error: null,
    data: {
      state: lastContactedAt ? "contacted" : "existing",
      normalizedEmail,
      lead: lead as Lead,
      messageCount: messages.length,
      sentCount: sent.length,
      lastContactedAt,
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