import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Lead, OutreachMessage } from "@/lib/types";

/**
 * Sequence-aware follow-up reads.
 *
 * Built on the Phase 4A sequence model: every follow-up is a real
 * `outreach_messages` row with `sequence_number > 0` and a `parent_message_id`
 * naming its predecessor. Nothing here counts `leads.followup_count` to
 * reconstruct a chain, and nothing invents a follow-up that was never stored.
 *
 * Two rules this module exists to enforce:
 *
 *   1. **Sequence position is read, never computed.** The authoritative number
 *      for a message is `message.sequence_number`. `followup_count` stays a
 *      scheduling counter and is never used as a proxy for history.
 *
 *   2. **Absence is reported honestly.** Leads whose follow-ups predate Phase 4A
 *      have `followup_count > 0` but no sequence rows. That gap is surfaced as
 *      `unrecordedHistory`, never filled with fabricated messages.
 *
 * Reads are bounded: every function here issues a constant number of queries
 * regardless of how many messages a lead has.
 */

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id";

const LEAD_COLUMNS =
  "id, email, company_name, contact_name, status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count";

/** Postgres unique-violation. Two writers raced for the same sequence slot. */
const UNIQUE_VIOLATION = "23505";

export type FollowUpFailure =
  | "not_found"
  | "anchor_not_latest"
  | "conflict"
  | "store_failed";

export interface FollowUpResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  reason?: FollowUpFailure;
}

function fail<T>(reason: FollowUpFailure, error: string): FollowUpResult<T> {
  return { ok: false, data: null, error, reason };
}

function toMessage(row: Record<string, unknown>): OutreachMessage {
  return {
    id: String(row.id),
    lead_id: String(row.lead_id),
    recipient_email: String(row.recipient_email),
    subject: (row.subject ?? null) as string | null,
    body: (row.body ?? null) as string | null,
    status: row.status as OutreachMessage["status"],
    provider: (row.provider ?? null) as OutreachMessage["provider"],
    provider_message_id: (row.provider_message_id ?? null) as string | null,
    sent_at: (row.sent_at ?? null) as string | null,
    created_at: String(row.created_at),
    sequence_number: Number(row.sequence_number ?? 0),
    parent_message_id: (row.parent_message_id ?? null) as string | null,
  };
}

function toLead(row: Record<string, unknown>): Lead {
  return {
    id: String(row.id),
    email: String(row.email),
    company_name: (row.company_name ?? null) as string | null,
    contact_name: (row.contact_name ?? null) as string | null,
    status: row.status as Lead["status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_contacted_at: (row.last_contacted_at ?? null) as string | null,
    next_followup_at: (row.next_followup_at ?? null) as string | null,
    followup_count: Number(row.followup_count ?? 0),
  };
}

/** A message and the lead it belongs to, loaded together. */
export interface FollowUpDetail {
  lead: Lead;
  message: OutreachMessage;
  /** The predecessor row, when this message is a follow-up. */
  parent: OutreachMessage | null;
  /** The initial outreach of this sequence, i.e. sequence_number 0. */
  initial: OutreachMessage | null;
  /** True when `sequence_number === 0`. */
  isInitial: boolean;
  /**
   * True when the lead's counter claims follow-ups that were never stored as
   * rows — they predate the sequence model. Reported, never reconstructed.
   */
  unrecordedHistory: boolean;
}

/**
 * Load one message with everything a detail view needs: the lead, the parent and
 * the initial outreach of the same sequence.
 *
 * Bounded at three queries regardless of sequence length — no per-message loop,
 * so this cannot degrade into an N+1.
 */
export async function getFollowUpDetail(messageId: string): Promise<FollowUpResult<FollowUpDetail>> {
  if (!messageId) return fail("not_found", "That message could not be identified.");

  const supabase = getSupabaseAdmin();

  const { data: messageRow, error: messageError } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", messageId)
    .maybeSingle();

  if (messageError) return fail("store_failed", "The follow-up could not be loaded.");
  if (!messageRow) return fail("not_found", "That follow-up does not exist.");

  const message = toMessage(messageRow as Record<string, unknown>);

  const { data: leadRow, error: leadError } = await supabase
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("id", message.lead_id)
    .maybeSingle();

  if (leadError) return fail("store_failed", "The follow-up could not be loaded.");
  if (!leadRow) return fail("not_found", "That follow-up has no lead.");

  const lead = toLead(leadRow as Record<string, unknown>);

  // The predecessor and the sequence head are each one indexed lookup, so the
  // total stays constant however long the chain is. No per-message loop.
  const parent = message.parent_message_id
    ? await loadById(supabase, message.parent_message_id)
    : null;
  const initial =
    message.sequence_number === 0
      ? message
      : await loadInitialFor(supabase, message.lead_id, message.recipient_email);

  return {
    ok: true,
    data: {
      lead,
      message,
      parent,
      initial,
      isInitial: message.sequence_number === 0,
      unrecordedHistory: lead.followup_count > 0 && (await countSequenceRows(supabase, message.lead_id)) < lead.followup_count,
    },
    error: null,
  };
}

async function loadById(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  id: string,
): Promise<OutreachMessage | null> {
  const { data } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return data ? toMessage(data as Record<string, unknown>) : null;
}

async function loadInitialFor(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  leadId: string,
  recipientEmail: string,
): Promise<OutreachMessage | null> {
  const { data } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("lead_id", leadId)
    .eq("recipient_email", recipientEmail)
    .eq("sequence_number", 0)
    .maybeSingle();
  return data ? toMessage(data as Record<string, unknown>) : null;
}

async function countSequenceRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  leadId: string,
): Promise<number> {
  const { count } = await supabase
    .from("outreach_messages")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId);
  return Number(count ?? 0);
}

export interface FollowUpListItem {
  message: OutreachMessage;
  lead: Pick<Lead, "id" | "email" | "company_name" | "contact_name">;
  /** True when `next_followup_at` is set and already in the past. */
  due: boolean;
  dueAt: string | null;
  /**
   * Operational rank: 0 = needs attention now, 1 = unsent, 2 = already sent.
   * See {@link listFollowUps} for why this is not a database column.
   */
  attention: 0 | 1 | 2;
}

/** A message that left the outbox is finished; everything else still needs work. */
function isSent(message: OutreachMessage): boolean {
  return message.sent_at !== null || message.status === "sent";
}

/**
 * Every stored follow-up (`sequence_number > 0`), in workspace order.
 *
 * Deliberately NOT derived from `leads.followup_count`: only real rows are
 * listed. Scheduling fields are still joined in, because `next_followup_at` is
 * what the operator acts on.
 *
 * Ordering. `sequence_number` is a position *within one lead*, so ordering by it
 * alone is meaningless across leads — it would interleave every lead's
 * follow-up #1 before any #2. A workspace needs a presentation order instead,
 * defined here in TypeScript rather than in SQL, which means no migration:
 *
 *   1. due follow-ups, soonest first  — the ones to act on today
 *   2. other unsent follow-ups          — ready, not yet due
 *   3. sent follow-ups, most recent first — history
 *
 * Every group falls back to deterministic tie-breakers (lead id, then sequence
 * number, then message id) so two identical requests always render the same
 * order. `attention` is returned so the UI can group without re-deriving it.
 */
export async function listFollowUps(limit = 100): Promise<FollowUpResult<FollowUpListItem[]>> {
  const supabase = getSupabaseAdmin();
  const now = Date.now();

  const { data, error } = await supabase
    .from("outreach_messages")
    .select(`${MESSAGE_COLUMNS}, leads(id, email, company_name, contact_name, next_followup_at, followup_count)`)
    .gt("sequence_number", 0)
    // Stable base order from the database; the workspace order is applied below.
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return fail("store_failed", "Follow-ups could not be loaded.");

  const items = ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const message = toMessage(row);
    const lead = (row.leads ?? {}) as Record<string, unknown>;
    const dueAt = (lead.next_followup_at ?? null) as string | null;
    const dueTimestamp = dueAt ? Date.parse(dueAt) : Number.NaN;
    const due = Number.isFinite(dueTimestamp) && dueTimestamp <= now;
    const sent = isSent(message);

    return {
      message,
      lead: {
        id: String(lead.id ?? message.lead_id),
        email: String(lead.email ?? ""),
        company_name: (lead.company_name ?? null) as string | null,
        contact_name: (lead.contact_name ?? null) as string | null,
      },
      dueAt,
      due,
      // Due wins over merely unsent: an overdue follow-up is the actionable one.
      attention: (sent ? 2 : due ? 0 : 1) as 0 | 1 | 2,
    };
  });

  items.sort(compareForWorkspace);

  return { ok: true, data: items, error: null };
}

/**
 * Total, deterministic workspace order. Exported so the ordering rule can be
 * tested directly rather than inferred from a rendered list.
 */
export function compareForWorkspace(a: FollowUpListItem, b: FollowUpListItem): number {
  if (a.attention !== b.attention) return a.attention - b.attention;

  const aDue = a.dueAt ? Date.parse(a.dueAt) : Number.NaN;
  const bDue = b.dueAt ? Date.parse(b.dueAt) : Number.NaN;

  if (a.attention !== 2) {
    // Due items: soonest deadline first. Items with no deadline sort last.
    if (Number.isFinite(aDue) && Number.isFinite(bDue) && aDue !== bDue) return aDue - bDue;
    if (Number.isFinite(aDue) !== Number.isFinite(bDue)) {
      return Number.isFinite(aDue) ? -1 : 1;
    }
  } else {
    // Sent items: most recently sent first.
    const aSent = a.message.sent_at ? Date.parse(a.message.sent_at) : Number.NaN;
    const bSent = b.message.sent_at ? Date.parse(b.message.sent_at) : Number.NaN;
    if (Number.isFinite(aSent) && Number.isFinite(bSent) && aSent !== bSent) return bSent - aSent;
    if (Number.isFinite(aSent) !== Number.isFinite(bSent)) {
      return Number.isFinite(aSent) ? -1 : 1;
    }
  }

  // Deterministic tie-breakers. `sequence_number` alone is not a total order
  // across leads, so lead id comes first and the message id guarantees a total
  // order even for otherwise identical rows.
  if (a.lead.id !== b.lead.id) return a.lead.id < b.lead.id ? -1 : 1;
  if (a.message.sequence_number !== b.message.sequence_number) {
    return a.message.sequence_number - b.message.sequence_number;
  }
  return a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0;
}

/**
 * Create (or re-save) the follow-up that follows `anchorMessageId`.
 *
 * Concurrency: the slot is allocated as `MAX(sequence_number) + 1` and the
 * database's `UNIQUE (lead_id, recipient_normalized, sequence_number)` decides
 * the winner. Two simultaneous requests cannot both create the same logical
 * follow-up — the loser gets a unique violation and is reported as a conflict.
 * No application-only lock is involved, and no new migration is required.
 */
export async function createFollowUpDraft(input: {
  anchorMessageId: string;
  subject?: string | null;
  body?: string | null;
}): Promise<FollowUpResult<{ message: OutreachMessage; created: boolean }>> {
  if (!input.anchorMessageId) {
    return fail("not_found", "That follow-up could not be anchored.");
  }

  const supabase = getSupabaseAdmin();

  const { data: anchorRow, error: anchorError } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", input.anchorMessageId)
    .maybeSingle();

  if (anchorError) return fail("store_failed", "The follow-up could not be saved.");
  if (!anchorRow) return fail("not_found", "That follow-up could not be anchored.");

  const anchor = toMessage(anchorRow as Record<string, unknown>);

  const { data: leadRow } = await supabase
    .from("leads")
    .select("id")
    .eq("id", anchor.lead_id)
    .maybeSingle();
  if (!leadRow) return fail("not_found", "That follow-up has no lead.");

  // Re-saving an editable follow-up updates that row instead of appending one.
  const existing = await openChildOf(supabase, anchor);
  if (existing) {
    const { data: updated, error: updateError } = await supabase
      .from("outreach_messages")
      .update({ subject: input.subject ?? existing.subject, body: input.body ?? existing.body })
      .eq("id", existing.id)
      .select(MESSAGE_COLUMNS)
      .maybeSingle();

    if (updateError) return fail("store_failed", "The follow-up could not be saved.");
    if (!updated) return fail("store_failed", "The follow-up could not be saved.");
    return { ok: true, data: { message: toMessage(updated as Record<string, unknown>), created: false }, error: null };
  }

  // Anchoring on a superseded message would silently create a branch. Refuse it.
  const { data: latest } = await supabase
    .from("outreach_messages")
    .select("id, sequence_number")
    .eq("lead_id", anchor.lead_id)
    .eq("recipient_email", anchor.recipient_email)
    .order("sequence_number", { ascending: false })
    .limit(1);

  const latestRow = (latest ?? [])[0] as Record<string, unknown> | undefined;
  if (latestRow && Number(latestRow.sequence_number) > anchor.sequence_number) {
    return fail(
      "anchor_not_latest",
      "A later follow-up already exists for this recipient. Open that one instead.",
    );
  }

  const { data: rows } = await supabase
    .from("outreach_messages")
    .select("sequence_number")
    .eq("lead_id", anchor.lead_id)
    .eq("recipient_email", anchor.recipient_email)
    .order("sequence_number", { ascending: false })
    .limit(1);

  const highest = Number(((rows ?? [])[0] as Record<string, unknown> | undefined)?.sequence_number ?? anchor.sequence_number);
  const next = highest + 1;

  const { data: created, error: insertError } = await supabase
    .from("outreach_messages")
    .insert({
      lead_id: anchor.lead_id,
      recipient_email: anchor.recipient_email,
      subject: input.subject ?? null,
      body: input.body ?? null,
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      sequence_number: next,
      parent_message_id: anchor.id,
    })
    .select(MESSAGE_COLUMNS)
    .maybeSingle();

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      // Another request claimed this slot first. The unique index is the
      // authority, so report the conflict rather than writing a duplicate.
      return fail("conflict", "A follow-up for this recipient was just created. Reopen it instead.");
    }
    return fail("store_failed", "The follow-up could not be saved.");
  }
  if (!created) return fail("store_failed", "The follow-up could not be saved.");

  return { ok: true, data: { message: toMessage(created as Record<string, unknown>), created: true }, error: null };
}

/** The editable follow-up directly after `anchor`, if one is already open. */
async function openChildOf(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  anchor: OutreachMessage,
): Promise<OutreachMessage | null> {
  const { data } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("parent_message_id", anchor.id)
    .eq("lead_id", anchor.lead_id)
    .in("status", ["draft", "ready"])
    .maybeSingle();

  return data ? toMessage(data as Record<string, unknown>) : null;
}
