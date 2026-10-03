import "server-only";

import {
  CONTACT_COOLDOWN_DAYS,
  evaluateQualityGate,
  type GateContext,
  type HistoryMessage,
  type QualityGateResult,
} from "@/lib/outreach/quality-gate";
import { normalizeEmail } from "@/lib/email";
import { findLeadByEmail } from "@/lib/services/lead-service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { OutreachMessage } from "@/lib/types";

/**
 * Server-side half of the outreach quality gate.
 *
 * The rules live in `@/lib/outreach/quality-gate` and are pure; this module
 * only supplies context and enforces the result. Two properties matter:
 *
 *   * **The server is the authority.** Every path that decides whether outreach
 *     may be recorded as sent comes through here, so a stale dashboard, a
 *     crafted request or a replayed action cannot skip a check. Nothing the
 *     client sends is treated as a verdict.
 *   * **Bounded queries.** The lead and its history are fetched with two
 *     constant queries regardless of how much history exists. Similarity is then
 *     computed in memory. There is deliberately no query-per-previous-message
 *     and no N+1: this runs on every draft check and every send.
 */

const MESSAGE_COLUMNS =
  "id, lead_id, recipient_email, subject, body, status, provider, provider_message_id, sent_at, created_at, sequence_number, parent_message_id";

export interface GateEvaluation extends QualityGateResult {
  /** Resolved lead, or null when the recipient does not exist yet. */
  leadId: string | null;
  normalizedRecipient: string | null;
  /** True when the draft is blocked, for callers that only need the verdict. */
  blocked: boolean;
  /** True when there is at least one warning the operator should confirm. */
  hasWarnings: boolean;
}

/** A draft as typed by the operator. Used for the live, pre-save check. */
export interface DraftGateInput {
  recipient: string;
  subject: string;
  body: string;
  /** Present when re-checking a draft that already exists. */
  messageId?: string | null;
  /** Skip history when the lead is already known and unchanged. */
  leadId?: string | null;
}

/** Map stored messages into the shape the pure gate compares. */
function toHistory(messages: Array<Record<string, unknown>>): HistoryMessage[] {
  return messages.map((row, index) => ({
    id: String(row.id),
    subject: (row.subject ?? null) as string | null,
    body: (row.body ?? null) as string | null,
    status: String(row.status),
    sentAt: (row.sent_at ?? null) as string | null,
    createdAt: String(row.created_at),
    index,
  }));
}

/**
 * Load the lead and its full message history.
 *
 * Two queries, always. An invalid or absent recipient resolves to no lead and
 * no history, which is the correct context for the gate to block on identity
 * grounds rather than an error to throw.
 */
async function loadContext(input: {
  recipient: string;
  messageId: string | null;
  leadId?: string | null;
  now?: Date;
}): Promise<{ context: GateContext; leadId: string | null }> {
  const now = input.now ?? new Date();
  const supabase = getSupabaseAdmin();

  let leadId = input.leadId ?? null;
  let lastContactedAt: string | null = null;

  const leadResult = await findLeadByEmail(input.recipient);
  if (leadResult.ok && leadResult.data?.lead) {
    leadId = leadResult.data.lead.id;
    lastContactedAt = leadResult.data.lastContactedAt;
  }

  if (!leadId) {
    return {
      leadId: null,
      context: {
        input: { recipient: input.recipient, subject: "", body: "", messageId: input.messageId },
        history: [],
        lastContactedAt: null,
        now,
      },
    };
  }

  // Queried here rather than through `getLeadOutreachHistory()` so this module
  // stays a leaf: the send path imports the gate, and importing it back would
  // be a cycle. Same table, same columns, same single query.
  const { data: messages } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });

  return {
    leadId,
    context: {
      input: { recipient: input.recipient, subject: "", body: "", messageId: input.messageId },
      history: messages ? toHistory(messages as unknown as Array<Record<string, unknown>>) : [],
      lastContactedAt,
      now,
    },
  };
}

function finish(
  result: QualityGateResult,
  leadId: string | null,
  normalizedRecipient: string | null,
): GateEvaluation {
  return {
    ...result,
    leadId,
    normalizedRecipient,
    blocked: result.status === "blocked",
    hasWarnings: result.status === "warning",
  };
}

/**
 * Evaluate a draft the operator is currently editing.
 *
 * This is the advisory path used by the dashboard. It never authorises a send
 * on its own — `evaluateStoredMessageQualityGate` re-runs the checks against
 * stored state at the moment of the send.
 */
export async function evaluateDraftQualityGate(
  input: DraftGateInput,
): Promise<GateEvaluation> {
  const normalizedRecipient = normalizeEmail(input.recipient);

  const { context, leadId } = await loadContext({
    recipient: input.recipient,
    messageId: input.messageId ?? null,
    leadId: input.leadId ?? null,
  });

  const result = evaluateQualityGate({
    ...context,
    input: {
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      messageId: input.messageId ?? null,
    },
  });

  return finish(result, leadId, normalizedRecipient || null);
}

/**
 * The stored message plus the verdict computed from it.
 *
 * The message is returned as well as the gate because the send path needs to
 * know whether it is already recorded — an idempotent repeat must not be turned
 * into a refusal, and the gate has nothing to authorise when no write will
 * happen anyway.
 */
export interface EvaluatedMessage {
  message: OutreachMessage;
  gate: GateEvaluation;
}

/**
 * Evaluate the message that is actually stored, for the send path.
 *
 * The draft is read back from Postgres rather than taken from the request, so
 * the verdict always describes what would really be recorded as sent — a stale
 * client cannot describe a different draft into existence. Returns null when the
 * message does not exist or belongs to a different lead, which the caller must
 * treat as a failure rather than as "no gate".
 */
export async function evaluateStoredMessageQualityGate(
  messageId: string,
  leadId: string,
): Promise<EvaluatedMessage | null> {
  const supabase = getSupabaseAdmin();

  const { data: message, error } = await supabase
    .from("outreach_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", messageId)
    .eq("lead_id", leadId)
    .maybeSingle();

  if (error || !message) return null;

  const row = message as unknown as Record<string, unknown>;
  const recipient = String(row.recipient_email ?? "");

  const { context, leadId: resolvedLeadId } = await loadContext({
    recipient,
    messageId,
    leadId,
  });

  const result = evaluateQualityGate({
    ...context,
    input: {
      recipient,
      subject: (row.subject ?? "") as string,
      body: (row.body ?? "") as string,
      // Excluded from its own history, so re-sending is not self-compared.
      messageId,
    },
  });

  return {
    message: row as unknown as OutreachMessage,
    gate: finish(result, resolvedLeadId, normalizeEmail(recipient) || null),
  };
}

/**
 * Human-readable summary for a blocked verdict.
 *
 * Only the blocking reasons are joined. Internal diagnostics, historical bodies
 * and anything resembling a credential are never included.
 */
export function describeBlocked(result: QualityGateResult): string {
  const blocking = result.checks.filter((check) => check.status === "block");
  if (blocking.length === 0) return "This draft is blocked by the quality gate.";
  return `Blocked by the quality gate: ${blocking.map((check) => check.reason).join(" ")}`;
}

export { CONTACT_COOLDOWN_DAYS };