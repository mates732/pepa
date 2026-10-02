import "server-only";

import {
  isWithinCadence,
  MAX_FOLLOW_UPS,
  nextFollowUpDueAt,
  toUtcIso,
} from "@/lib/followup/cadence";
import { buildDeepLink } from "@/lib/config/base-url";
import { getNotificationService } from "@/lib/providers/registry";
import type { ActionNotification, DueFollowUp, FollowUpService } from "@/lib/providers/types";
import { mintFollowUpToken } from "@/lib/services/action-token-service";
import { toActionNotification } from "@/lib/telegram/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Lead, OutreachMessage } from "@/lib/types";

/**
 * Follow-up engine.
 *
 * Per due follow-up, in order:
 *   1. CLAIM it atomically via a unique constraint (not a JS mutex);
 *   2. mint the opaque deep link;
 *   3. hand a channel-agnostic ActionNotification to NotificationService;
 *   4. record success — or release the claim so the next run retries.
 *
 * It never sends email. The operator reviews and sends manually.
 *
 * Design note on scheduling: `next_followup_at` is deliberately NOT advanced
 * when a follow-up is notified. Doing so would queue follow-ups #2 and #3 for
 * messages that were never sent. It advances in `markFollowUpSent()`, which the
 * future EmailProvider calls at actual send time.
 */

/** How long a `claimed` row is honoured before another run may take it over. */
export const CLAIM_LEASE_MS = 30 * 60 * 1000;

const DEFAULT_BATCH_LIMIT = 25;

/** The slice of a notification channel the engine actually needs. */
export interface ActionNotifier {
  sendActionNotification(notification: ActionNotification): Promise<void>;
}

export interface ProcessOutcome {
  examined: number;
  notified: number;
  skippedAlreadyNotified: number;
  skippedBusy: number;
  skippedMaxCadence: number;
  failed: number;
}

export interface ProcessOptions {
  /** Injected by tests; defaults to the registered notification channel. */
  notifier?: ActionNotifier;
  limit?: number;
  now?: Date;
}

export interface ProcessedFollowUp {
  leadId: string;
  followUpNumber: number;
}

/**
 * A due follow-up whose anchor message is known. `due_followups` inner-joins the
 * latest *sent* message, so this is guaranteed by the view, not by a guess.
 */
export interface ResolvedDueFollowUp extends DueFollowUp {
  lastMessage: OutreachMessage;
}

/**
 * Selects due follow-ups.
 *
 * Eligibility (replied / completed / blocked, existence of a sent message, and
 * the `next_followup_at <= now()` comparison on real timestamptz) lives in the
 * `due_followups` view. The cadence maximum is applied here, where the cadence
 * configuration lives.
 */
export async function listDueFollowUps(
  limit = DEFAULT_BATCH_LIMIT,
): Promise<ResolvedDueFollowUp[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("due_followups")
    .select(
      "lead_id, email, company_name, contact_name, lead_status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count, outreach_id, recipient_email, subject, body, outreach_status, sent_at, outreach_created_at, followup_number",
    )
    .order("next_followup_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map(toDueFollowUp)
    .filter((entry): entry is ResolvedDueFollowUp => entry !== null);
}

function toDueFollowUp(row: Record<string, unknown>): ResolvedDueFollowUp | null {
  const followUpNumber = Number(row.followup_number);
  if (!Number.isFinite(followUpNumber) || followUpNumber < 1) return null;
  if (!row.outreach_id) return null;

  return {
    lead: {
      id: String(row.lead_id),
      email: String(row.email),
      company_name: (row.company_name ?? null) as string | null,
      contact_name: (row.contact_name ?? null) as string | null,
      status: row.lead_status as Lead["status"],
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_contacted_at: (row.last_contacted_at ?? null) as string | null,
      next_followup_at: (row.next_followup_at ?? null) as string | null,
      followup_count: Number(row.followup_count ?? 0),
    },
    lastMessage: {
      id: String(row.outreach_id),
      lead_id: String(row.lead_id),
      recipient_email: String(row.recipient_email),
      subject: (row.subject ?? null) as string | null,
      body: (row.body ?? null) as string | null,
      status: row.outreach_status as OutreachMessage["status"],
      provider: null,
      provider_message_id: null,
      sent_at: (row.sent_at ?? null) as string | null,
      created_at: String(row.outreach_created_at),
    },
    dueAt: String(row.next_followup_at),
    attempt: followUpNumber,
  };
}

type ClaimResult = "claimed" | "already_notified" | "busy";

/**
 * Atomically take ownership of a follow-up.
 *
 * The INSERT leans on `unique (lead_id, followup_number)`: concurrent schedulers
 * race and exactly one wins, decided by Postgres rather than by a JS mutex.
 */
async function claimFollowUp(
  leadId: string,
  outreachId: string | null,
  followUpNumber: number,
  now: Date,
): Promise<ClaimResult> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("followup_notifications")
    .insert({
      lead_id: leadId,
      outreach_id: outreachId,
      followup_number: followUpNumber,
      status: "claimed",
      claimed_at: toUtcIso(now),
    })
    .select("id, status")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return resolveExistingClaim(leadId, followUpNumber, now);
    throw new Error(error.message);
  }
  if (data) return "claimed";

  return resolveExistingClaim(leadId, followUpNumber, now);
}

/** Decide what to do about a follow-up that already has a ledger row. */
async function resolveExistingClaim(
  leadId: string,
  followUpNumber: number,
  now: Date,
): Promise<ClaimResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("followup_notifications")
    .select("id, status, claimed_at")
    .eq("lead_id", leadId)
    .eq("followup_number", followUpNumber)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return "busy";

  const row = data as { id: string; status: string; claimed_at: string };
  if (row.status === "sent") return "already_notified";

  // An unexpired lease belongs to another run: leave it alone.
  const claimedAt = Date.parse(row.claimed_at);
  if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < CLAIM_LEASE_MS) {
    return "busy";
  }

  // Expired lease (crashed worker): compare-and-set on exactly the row we read.
  const { data: taken, error: takeoverError } = await supabase
    .from("followup_notifications")
    .update({ status: "claimed", claimed_at: toUtcIso(now) })
    .eq("id", row.id)
    .eq("status", "claimed")
    .eq("claimed_at", row.claimed_at)
    .select("id")
    .maybeSingle();

  if (takeoverError) throw new Error(takeoverError.message);
  return taken ? "claimed" : "busy";
}

async function markNotified(
  leadId: string,
  followUpNumber: number,
  actionTokenId: string,
  now: Date,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("followup_notifications")
    .update({ status: "sent", sent_at: toUtcIso(now), action_token_id: actionTokenId })
    .eq("lead_id", leadId)
    .eq("followup_number", followUpNumber);
  if (error) throw new Error(error.message);
}

/**
 * Release a claim after a failed send, so the follow-up stays due and the next
 * run retries it. A Telegram failure is never recorded as a notification.
 */
async function releaseClaim(leadId: string, followUpNumber: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("followup_notifications")
    .delete()
    .eq("lead_id", leadId)
    .eq("followup_number", followUpNumber)
    .eq("status", "claimed");
  if (error) throw new Error(error.message);
}

/**
 * Process every due follow-up at most once.
 *
 * A single bad follow-up never aborts the run: it is counted and the loop
 * continues, so one poisonous row cannot block the queue.
 */
export async function processDueFollowUps(options: ProcessOptions = {}): Promise<ProcessOutcome> {
  const now = options.now ?? new Date();
  const outcome: ProcessOutcome = {
    examined: 0,
    notified: 0,
    skippedAlreadyNotified: 0,
    skippedBusy: 0,
    skippedMaxCadence: 0,
    failed: 0,
  };

  const channel = options.notifier ?? getNotificationService();
  const send = channel?.sendActionNotification?.bind(channel);

  const due = await listDueFollowUps(options.limit ?? DEFAULT_BATCH_LIMIT);

  for (const entry of due) {
    // Past follow-up #3 PEPA stops chasing, even if next_followup_at is still set.
    if (!isWithinCadence(entry.attempt)) {
      outcome.skippedMaxCadence += 1;
      await clearFollowUpSchedule(entry.lead.id).catch(() => undefined);
      continue;
    }

    outcome.examined += 1;

    if (!send) {
      outcome.failed += 1;
      continue;
    }

    let claim: ClaimResult;
    try {
      claim = await claimFollowUp(entry.lead.id, entry.lastMessage.id, entry.attempt, now);
    } catch {
      outcome.failed += 1;
      continue;
    }

    if (claim === "already_notified") {
      outcome.skippedAlreadyNotified += 1;
      continue;
    }
    if (claim === "busy") {
      outcome.skippedBusy += 1;
      continue;
    }

    let delivered = false;
    try {
      const token = await mintFollowUpToken({
        leadId: entry.lead.id,
        outreachId: entry.lastMessage.id,
      });
      if (!token.ok || !token.data) throw new Error(token.error ?? "Could not mint a deep link.");

      const notification = toActionNotification({
        leadName: entry.lead.company_name ?? entry.lead.contact_name,
        email: entry.lead.email,
        attempt: entry.attempt,
        lastContactedAt: entry.lead.last_contacted_at,
        deepLink: await buildDeepLink(token.data.token),
      });

      await send(notification);
      delivered = true;

      await markNotified(entry.lead.id, entry.attempt, token.data.id, now);
      outcome.notified += 1;
    } catch {
      outcome.failed += 1;
      if (!delivered) {
        // Never sent: release immediately so the next run retries.
        await releaseClaim(entry.lead.id, entry.attempt).catch(() => undefined);
      }
      // If it WAS sent but bookkeeping failed, the claim is left alone: the lease
      // expires and a later run reclaims it. Better a delayed retry than a second
      // Telegram message right now.
    }
  }

  return outcome;
}

/** Stop re-checking a lead that has exhausted the cadence. */
async function clearFollowUpSchedule(leadId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("leads")
    .update({ next_followup_at: null })
    .eq("id", leadId);
  if (error) throw new Error(error.message);
}

/**
 * Advance the schedule after the operator actually sends a follow-up.
 * Called by the future EmailProvider; not wired to anything yet.
 */
export async function markFollowUpSent(input: {
  leadId: string;
  sentAt?: Date;
}): Promise<{ nextFollowUpAt: string | null }> {
  const supabase = getSupabaseAdmin();
  const sentAt = input.sentAt ?? new Date();
  const attempt = (await currentFollowUpCount(input.leadId)) + 1;

  const due = nextFollowUpDueAt(sentAt, attempt);
  const { error } = await supabase
    .from("leads")
    .update({
      followup_count: attempt,
      last_contacted_at: toUtcIso(sentAt),
      next_followup_at: due ? toUtcIso(due) : null,
    })
    .eq("id", input.leadId);

  if (error) throw new Error(error.message);
  return { nextFollowUpAt: due ? toUtcIso(due) : null };
}

async function currentFollowUpCount(leadId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("leads")
    .select("followup_count")
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Number((data as { followup_count?: number } | null)?.followup_count ?? 0);
}

/**
 * `FollowUpService` over the same primitives, for callers that want the
 * interface rather than the batch runner (e.g. the follow-up composer).
 */
export const followUpService: FollowUpService = {
  async listDue(limit?: number) {
    return listDueFollowUps(limit);
  },

  async scheduleNext(leadId: string, dueAt: string) {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("leads")
      .update({ next_followup_at: dueAt })
      .eq("id", leadId);
    if (error) throw new Error(error.message);
  },

  async cancelPending(leadId: string) {
    const supabase = getSupabaseAdmin();
    // Clearing the schedule stops the engine. A reply should additionally mark
    // the lead `replied`, which belongs to the future reply-detection phase.
    await clearFollowUpSchedule(leadId);
    await supabase
      .from("followup_notifications")
      .delete()
      .eq("lead_id", leadId)
      .eq("status", "claimed");
  },
};

export { MAX_FOLLOW_UPS };