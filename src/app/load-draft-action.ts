"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { OutreachMessage, Lead } from "@/lib/types";

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id";

const LEAD_COLUMNS =
  "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count";

export interface LoadDraftResult {
  ok: true;
  lead: Lead;
  message: OutreachMessage;
}

export interface LoadDraftFailure {
  ok: false;
  error: string;
}

export type LoadDraftResponse = LoadDraftResult | LoadDraftFailure;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(error: string): LoadDraftFailure {
  return { ok: false, error };
}

/**
 * Load a single draft by its message ID.
 * Returns the message and its associated lead.
 */
export async function loadDraftById(messageId: string): Promise<LoadDraftResponse> {
  await requireAuthenticatedUser();

  if (!messageId || !UUID_PATTERN.test(messageId)) {
    return failure("That draft could not be identified.");
  }

  try {
    const supabase = getSupabaseAdmin();

    const { data: message, error: msgError } = await supabase
      .from("outreach_messages")
      .select(MESSAGE_COLUMNS)
      .eq("id", messageId)
      .maybeSingle();

    if (msgError) return failure("Could not load the draft.");
    if (!message) return failure("That draft does not exist.");

    const msg = message as OutreachMessage;

    // Load the associated lead
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("id", msg.lead_id)
      .maybeSingle();

    if (leadError || !lead) return failure("That draft has no associated lead.");

    return {
      ok: true,
      lead: lead as Lead,
      message: msg,
    };
  } catch {
    return failure("Could not load the draft.");
  }
}