export const LEAD_STATUSES = [
  "draft",
  "ready",
  "sent",
  "replied",
  "follow_up",
  "completed",
  "blocked",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type EmailProviderId = "gmail" | "apple_mail" | (string & {});

export interface Lead {
  id: string;
  email: string;
  company_name: string | null;
  contact_name: string | null;
  status: LeadStatus;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  next_followup_at: string | null;
  followup_count: number;
}

export interface OutreachMessage {
  id: string;
  lead_id: string;
  recipient_email: string;
  subject: string | null;
  body: string | null;
  status: LeadStatus;
  provider: EmailProviderId | null;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface ParsedOutreachInput {
  recipient: string;
  subject: string;
  body: string;
  /** Fields that were not present in the pasted text. */
  missing: Array<"recipient" | "subject" | "body">;
  /** Non-fatal notes, e.g. unrecognised leading lines. */
  warnings: string[];
}

/**
 * Result of the server-side duplicate check. Derived from the database, never
 * from a client-side lookup, so the UI cannot drift from the stored truth.
 */
export type DuplicateState = "new" | "existing" | "contacted";

export interface DuplicateCheckResult {
  state: DuplicateState;
  normalizedEmail: string;
  lead: Lead | null;
  /** Total outreach messages ever attached to the lead. */
  messageCount: number;
  /** Only messages that actually left the outbox (status sent/follow_up/replied). */
  sentCount: number;
  lastContactedAt: string | null;
}

export interface OutreachHistoryRow extends Lead {
  latestSubject: string | null;
  latestMessageStatus: LeadStatus | null;
  latestMessageAt: string | null;
  messageCount: number;
}

export interface ServiceResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}