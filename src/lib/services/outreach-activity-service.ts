import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Lead, OutreachMessage } from "@/lib/types";

/**
 * Outreach Activity — the chronological record of what was actually sent.
 *
 * One rule defines this module and the feature it backs:
 *
 *   An activity record is an `outreach_messages` row with `status = 'sent'`.
 *   Nothing else.
 *
 * Deliberately NOT sources of activity:
 *
 *   * `leads.followup_count` — a scheduling counter. It says *how many*
 *     follow-ups went out, never *which* message each one was, and it survives
 *     no subject, body, recipient or timestamp. Activity cannot be rebuilt from
 *     it without inventing messages.
 *   * `leads.last_contacted_at` / `leads.next_followup_at` — derived schedule
 *     fields. They describe when the engine *intends* to act, not what went out.
 *   * `leads.status` — a lead can sit at `follow_up` or `replied` while no row
 *     was ever recorded as sent.
 *
 * There is no parallel history table, and no row is ever synthesised. A follow-up
 * that predates the Phase 4A sequence model was never stored as a message, so it
 * simply is not here — that gap is reported, never filled.
 *
 * `sent_at` is the authoritative activity timestamp, so it is both the filter's
 * companion and the ordering key: `sent_at DESC, id DESC`.
 */

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id";

/**
 * How many sent messages one workspace load returns.
 *
 * Matches `listFollowUps()`. Activity is a recent-activity window, not a
 * lifetime archive: the UI states that explicitly rather than implying the list
 * is complete, and no count of all-time sends is ever claimed from it.
 */
export const ACTIVITY_DEFAULT_LIMIT = 100;

/** Hard ceiling, so a caller cannot turn this into an unbounded read. */
export const ACTIVITY_MAX_LIMIT = 500;

/** The only status that counts as activity. */
export const ACTIVITY_STATUS = "sent";

export type ActivityFailure = "not_found" | "store_failed";

export interface ActivityResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  reason?: ActivityFailure;
}

function fail<T>(reason: ActivityFailure, error: string): ActivityResult<T> {
  return { ok: false, data: null, error, reason };
}

/**
 * "Initial outreach" or "Follow-up #N", read from `sequence_number` alone.
 *
 * The subject and body are never inspected: a follow-up whose subject happens to
 * say "first email" is still follow-up #3, and `followup_count` is never consulted.
 */
export function describeOutreachType(sequenceNumber: number | null | undefined): string {
  const slot = Number(sequenceNumber ?? 0);
  if (!Number.isFinite(slot) || slot <= 0) return "Initial outreach";
  return `Follow-up #${slot}`;
}

/** The minimum an activity row needs to render without a second query. */
export interface OutreachActivityItem {
  message: OutreachMessage;
  lead: Pick<Lead, "id" | "email" | "company_name" | "contact_name">;
  /** "Initial outreach" or "Follow-up #N", derived from `sequence_number`. */
  typeLabel: string;
}

function toMessage(row: Record<string, unknown>): OutreachMessage {
  return {
    id: String(row.id),
    lead_id: String(row.lead_id),
    recipient_email: String(row.recipient_email ?? ""),
    subject: (row.subject ?? null) as string | null,
    body: (row.body ?? null) as string | null,
    status: row.status as OutreachMessage["status"],
    provider: (row.provider ?? null) as OutreachMessage["provider"],
    provider_message_id: (row.provider_message_id ?? null) as string | null,
    sent_at: (row.sent_at ?? null) as string | null,
    created_at: String(row.created_at ?? ""),
    sequence_number: Number(row.sequence_number ?? 0),
    parent_message_id: (row.parent_message_id ?? null) as string | null,
  };
}

function toLeadSummary(row: Record<string, unknown> | null, fallbackLeadId: string): OutreachActivityItem["lead"] {
  const lead = (row ?? {}) as Record<string, unknown>;
  return {
    id: String(lead.id ?? fallbackLeadId),
    email: String(lead.email ?? ""),
    company_name: (lead.company_name ?? null) as string | null,
    contact_name: (lead.contact_name ?? null) as string | null,
  };
}

function toItem(row: Record<string, unknown>): OutreachActivityItem {
  const message = toMessage(row);
  return {
    message,
    lead: toLeadSummary(row.leads as Record<string, unknown> | null, message.lead_id),
    typeLabel: describeOutreachType(message.sequence_number),
  };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Clamp a caller-supplied limit into a sane, bounded range. */
export function normalizeActivityLimit(limit?: number | null): number {
  const requested = Number(limit);
  if (!Number.isFinite(requested) || requested <= 0) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(Math.floor(requested), ACTIVITY_MAX_LIMIT);
}

/**
 * Chronological activity order: newest sent first, then message id descending.
 *
 * `sent_at` is authoritative. A row with no usable `sent_at` sorts last rather
 * than being presented as recent — it is an anomaly, not a fresh send, and
 * ordering it to the top would be a claim the timestamp does not support.
 *
 * The id tie-breaker makes the order total: two sends recorded in the same
 * instant always render the same way, so the workspace never reshuffles between
 * loads. Exported so the rule can be tested directly.
 */
export function compareForActivity(a: OutreachActivityItem, b: OutreachActivityItem): number {
  const aSent = parseTimestamp(a.message.sent_at);
  const bSent = parseTimestamp(b.message.sent_at);

  if (aSent !== bSent) {
    if (aSent === null) return 1;
    if (bSent === null) return -1;
    return bSent - aSent;
  }

  return a.message.id < b.message.id ? 1 : a.message.id > b.message.id ? -1 : 0;
}

/**
 * The recent window of sent outreach, newest first.
 *
 * One bounded query. The lead is joined in by the database rather than fetched
 * per row, so the cost is a single round trip no matter how many messages come
 * back — there is no per-item query to grow into an N+1.
 *
 * Ordering happens twice on purpose:
 *
 *   * In Postgres, so `LIMIT` keeps the newest rows. `nullsFirst: false` is
 *     essential here: Postgres sorts NULLs first under `DESC` by default, which
 *     would let sent rows with no `sent_at` occupy the whole window.
 *   * In TypeScript, via {@link compareForActivity}, so the presented order is
 *     total and testable independently of the driver.
 */
export async function listOutreachActivity(
  limit?: number | null,
): Promise<ActivityResult<OutreachActivityItem[]>> {
  const bounded = normalizeActivityLimit(limit);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("outreach_messages")
    .select(`${MESSAGE_COLUMNS}, leads(id, email, company_name, contact_name)`)
    // The single definition of an activity record.
    .eq("status", ACTIVITY_STATUS)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(bounded);

  if (error) return fail("store_failed", "Activity could not be loaded.");

  const items = ((data ?? []) as Array<Record<string, unknown>>).map(toItem);
  items.sort(compareForActivity);

  return { ok: true, data: items, error: null };
}

export interface OutreachActivityDetail {
  message: OutreachMessage;
  lead: OutreachActivityItem["lead"];
  /** The direct predecessor row, when it still exists and belongs to this lead. */
  parent: OutreachMessage | null;
  /** The sequence head (`sequence_number = 0`) of the same lead/recipient. */
  initial: OutreachMessage | null;
  /** True when `sequence_number === 0`. */
  isInitial: boolean;
  typeLabel: string;
}

/**
 * Load one sent message for the activity detail view.
 *
 * The status filter is applied to the lookup itself, so an unsent draft cannot
 * be reached through this surface at all — Activity has no entry point for
 * something that was never sent.
 *
 * Bounded at four queries regardless of how long the real chain is: the message,
 * its lead, its predecessor and its sequence head. Each of the last two is a
 * single indexed lookup, so no loop over the chain exists to become an N+1.
 *
 * Absences are reported, never filled. A missing predecessor is a deleted row
 * (Phase 4A uses `ON DELETE SET NULL`); a missing head means the initial outreach
 * was never stored. Neither is reconstructed.
 */
export async function getOutreachActivityDetail(
  messageId: string,
): Promise<ActivityResult<OutreachActivityDetail>> {
  if (!messageId) return fail("not_found", "That outreach could not be identified.");

  const supabase = getSupabaseAdmin();

  const { data: messageRow, error: messageError } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", messageId)
    .eq("status", ACTIVITY_STATUS)
    .maybeSingle();

  if (messageError) return fail("store_failed", "That outreach could not be loaded.");
  if (!messageRow) return fail("not_found", "That outreach is not in the activity history.");

  const message = toMessage(messageRow as Record<string, unknown>);

  const { data: leadRow, error: leadError } = await supabase
    .from("leads")
    .select("id, email, company_name, contact_name")
    .eq("id", message.lead_id)
    .maybeSingle();

  if (leadError) return fail("store_failed", "That outreach could not be loaded.");
  if (!leadRow) return fail("not_found", "That outreach has no lead.");

  const lead = toLeadSummary(leadRow as Record<string, unknown>, message.lead_id);

  const parent = message.parent_message_id
    ? await loadById(supabase, message.parent_message_id)
    : null;

  // A `parent_message_id` that crosses leads would graft one lead's chain onto
  // another's history. The database trigger refuses that on write, but this
  // read is the boundary the UI actually renders, so it is checked here too.
  const scopedParent = parent && parent.lead_id === message.lead_id ? parent : null;

  const initial =
    message.sequence_number === 0
      ? message
      : await loadInitialFor(supabase, message.lead_id, message.recipient_email);

  return {
    ok: true,
    data: {
      message,
      lead,
      parent: scopedParent,
      initial,
      isInitial: message.sequence_number === 0,
      typeLabel: describeOutreachType(message.sequence_number),
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