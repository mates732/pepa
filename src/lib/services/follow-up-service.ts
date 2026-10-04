import "server-only";

import {
  isWithinCadence,
  MAX_FOLLOW_UPS,
  nextFollowUpDueAt,
  toUtcIso,
} from "@/lib/followup/cadence";
import { buildDeepLink } from "@/lib/config/base-url";
import { getNotificationChannel } from "@/lib/providers/notifications";
import type { ActionNotification, DueFollowUp, FollowUpService } from "@/lib/providers/types";
import { mintFollowUpToken } from "@/lib/services/action-token-service";
import { toActionNotification } from "@/lib/telegram/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Lead, OutreachMessage } from "@/lib/types";

/**
 * Follow-up engine.
 *
 * Per due follow-up, in order:
 *   1. RESOLVE the real follow-up row this due event is about;
 *   2. CLAIM it atomically via a unique constraint (not a JS mutex);
 *   3. mint the opaque deep link;
 *   4. hand a channel-agnostic ActionNotification to NotificationService;
 *   5. record success — or release the claim so the next run retries.
 *
 * It never sends email. The operator reviews and sends manually.
 *
 * Design note on scheduling: `next_followup_at` is deliberately NOT advanced
 * when a follow-up is notified. Doing so would queue follow-ups #2 and #3 for
 * messages that were never sent. It advances in `markFollowUpSent()`, which
 * `recordOutreachSent()` calls at actual send time.
 *
 * ---------------------------------------------------------------------------
 * Notification identity (Phase 8A)
 * ---------------------------------------------------------------------------
 * The scheduler answers two separate questions, and they must not be confused:
 *
 *   "Is this lead due?"            → `next_followup_at`, i.e. SCHEDULING.
 *   "Which follow-up is it about?" → a real `outreach_messages` row with
 *                                    `sequence_number > 0`, i.e. IDENTITY.
 *
 * `due_followups.followup_number` is `leads.followup_count + 1`, and the view's
 * `outreach_id` is the last message that actually went out. Neither is the
 * follow-up being announced: the counter is a scheduling tally (and drifts
 * permanently on leads whose follow-ups predate the Phase 4A sequence model),
 * and the anchor is by definition an email that was already sent. Notifying from
 * those two values produced a Telegram message reading "Follow-up #2" for a row
 * that did not exist, with a deep link pointing at the previous email.
 *
 * So the number a notification carries is now read, never computed: it is
 * `message.sequence_number` of a stored, unsent follow-up row. A due lead with
 * no such row is skipped and counted (`skippedUnrecorded`), because there is
 * nothing true to announce — the Phase 4C workspace already lists it as pending.
 *
 * The same number keys the ledger (`unique (lead_id, followup_number)`), which
 * keeps one notification per (lead, follow-up row) and keeps the deep link and
 * the ledger pointing at the same message.
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
  /**
   * A due lead whose next follow-up has already gone out. Reported separately
   * from `notified` so a stale "still due" signal is visible rather than silent.
   */
  skippedAlreadySent: number;
  /**
   * A due lead with no stored follow-up row at all — either nothing was ever
   * drafted, or `followup_count` describes follow-ups that predate the sequence
   * model and were never stored. Reported, never reconstructed.
   */
  skippedUnrecorded: number;
  /**
   * A lead carrying two recipients at the same sequence slot. The ledger is
   * keyed per (lead, follow-up number) and cannot tell those apart, so no
   * notification is sent rather than the wrong one.
   */
  skippedAmbiguous: number;
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
      "lead_id, email, company_name, contact_name, lead_status, created_at, updated_at, last_contacted_at, next_followup_at, followup_count, outreach_id, recipient_email, subject, body, outreach_status, sent_at, outreach_created_at, followup_number, anchor_sequence_number",
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
      // The view anchors a follow-up on the highest *sent* message in the
      // sequence, so this is the position of the email it hangs off.
      sequence_number: Number(row.anchor_sequence_number ?? 0),
      parent_message_id: null,
    },
    dueAt: String(row.next_followup_at),
    attempt: followUpNumber,
  };
}

/**
 * Columns needed to decide whether a stored follow-up may be notified.
 *
 * `subject` and `body` are read because the deep link lands the operator on that
 * row's own composer. Neither ever reaches the Telegram payload.
 */
const FOLLOW_UP_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id";

/**
 * Statuses that mean the message has left the outbox for good. Mirrors the
 * exclusions in the `due_followups` view and `outreach-service`'s
 * `SENDABLE_STATUSES`, so "still actionable" means the same thing everywhere.
 */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["sent", "replied", "completed", "blocked"]);

/** A follow-up that has not gone out yet, and therefore still needs attention. */
function isOpenFollowUp(message: OutreachMessage): boolean {
  return message.sent_at === null && !CLOSED_STATUSES.has(message.status);
}

function toStoredMessage(row: Record<string, unknown>): OutreachMessage {
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

/** Why a due lead did or did not yield a notification. */
export type FollowUpState =
  /** A real, stored, unsent follow-up row. This is what may be notified. */
  | "due"
  /** The next follow-up already went out; announcing it would be stale. */
  | "already_sent"
  /** No follow-up row exists. Never reconstructed, never notified. */
  | "not_stored"
  /** Two recipients occupy the same sequence slot; the ledger cannot separate them. */
  | "ambiguous";

export interface FollowUpResolution {
  state: FollowUpState;
  /** Non-null only when `state === "due"`. */
  message: OutreachMessage | null;
}

/**
 * Resolve a due lead to the exact follow-up row it should be notified about.
 *
 * Scoped to `parent_message_id = anchorMessageId`, the same anchor the
 * `due_followups` view picked: the latest message that actually went out. The
 * follow-up that follows it is the next unsent step in that conversation, and
 * following the real parent link is what keeps the notification on the same
 * sequence the view is already reporting — no counter arithmetic is involved.
 *
 * Rows are read newest-slot-first and at most two are fetched: the second one is
 * only needed to detect two recipients sharing a slot, which `unique (lead_id,
 * followup_number)` in the ledger cannot represent.
 */
export async function resolveFollowUpTarget(
  leadId: string,
  anchorMessageId: string,
): Promise<FollowUpResolution> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("outreach_messages")
    .select(FOLLOW_UP_COLUMNS)
    .eq("lead_id", leadId)
    .eq("parent_message_id", anchorMessageId)
    .gt("sequence_number", 0)
    .order("sequence_number", { ascending: false })
    .limit(2);

  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(toStoredMessage);
  const open = rows.filter(isOpenFollowUp);

  if (open.length === 0) {
    return { state: rows.length > 0 ? "already_sent" : "not_stored", message: null };
  }

  const target = open[0];
  if (open.length > 1 && open[1].sequence_number === target.sequence_number) {
    return { state: "ambiguous", message: null };
  }

  return { state: "due", message: target };
}

/**
 * True when this follow-up was already notified under the pre-Phase-8A numbering.
 *
 * Ledger rows written before this phase used `leads.followup_count + 1`, which on
 * a lead with unrecorded history is a different number from the row's own
 * `sequence_number`. Reading only the new key would let those leads be announced
 * a second time. The old key is therefore still honoured: one delivery per
 * follow-up, whichever numbering created it, with no migration and no way to
 * distinguish the two cases in the data.
 */
async function hasLegacyNotification(
  leadId: string,
  legacyNumber: number,
  sequenceNumber: number,
): Promise<boolean> {
  if (legacyNumber === sequenceNumber) return false;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("followup_notifications")
    .select("id")
    .eq("lead_id", leadId)
    .eq("followup_number", legacyNumber)
    .eq("status", "sent")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data);
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
    skippedAlreadySent: 0,
    skippedUnrecorded: 0,
    skippedAmbiguous: 0,
    failed: 0,
  };

  // `getNotificationChannel()` comes from the registration module, so importing
  // this service is enough to make a channel resolvable. Asking the bare
  // registry instead returns null whenever nothing else happened to import the
  // registration module — which is exactly what a bare cron route does.
  const channel = options.notifier ?? getNotificationChannel();
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

    // Identity before idempotency: a claim is only ever taken for a follow-up
    // row that actually exists, so the ledger can never record a notification
    // for a message the database does not hold.
    let resolution: FollowUpResolution;
    try {
      resolution = await resolveFollowUpTarget(entry.lead.id, entry.lastMessage.id);
    } catch {
      outcome.failed += 1;
      continue;
    }

    if (resolution.state === "already_sent") {
      outcome.skippedAlreadySent += 1;
      continue;
    }
    if (resolution.state === "not_stored") {
      outcome.skippedUnrecorded += 1;
      continue;
    }
    if (resolution.state === "ambiguous" || !resolution.message) {
      outcome.skippedAmbiguous += 1;
      continue;
    }

    // The authoritative follow-up number, read from the row itself.
    const followUp = resolution.message;
    const sequenceNumber = followUp.sequence_number;

    try {
      if (await hasLegacyNotification(entry.lead.id, entry.attempt, sequenceNumber)) {
        outcome.skippedAlreadyNotified += 1;
        continue;
      }
    } catch {
      outcome.failed += 1;
      continue;
    }

    let claim: ClaimResult;
    try {
      claim = await claimFollowUp(entry.lead.id, followUp.id, sequenceNumber, now);
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
      // The token carries the follow-up itself, not the message it follows, so
      // the link resolves to the exact row and the ledger's `outreach_id`
      // names the same message the operator was told about.
      const token = await mintFollowUpToken({
        leadId: entry.lead.id,
        outreachId: followUp.id,
      });
      if (!token.ok || !token.data) throw new Error(token.error ?? "Could not mint a deep link.");

      const notification = toActionNotification({
        leadName: entry.lead.company_name ?? entry.lead.contact_name,
        email: followUp.recipient_email,
        // Read, never computed: this is the row's own position in the sequence.
        attempt: sequenceNumber,
        lastContactedAt: entry.lead.last_contacted_at,
        deepLink: await buildDeepLink(token.data.token),
      });

      await send(notification);
      delivered = true;

      await markNotified(entry.lead.id, sequenceNumber, token.data.id, now);
      outcome.notified += 1;
    } catch {
      outcome.failed += 1;
      if (!delivered) {
        // Never sent: release immediately so the next run retries.
        await releaseClaim(entry.lead.id, sequenceNumber).catch(() => undefined);
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