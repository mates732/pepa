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

/**
 * Machine-readable reasons the send path refuses outreach.
 *
 * `ALREADY_CONTACTED` is the address-level guard: this exact address is already
 * on record. `ALREADY_CONTACTED_DOMAIN` is the secondary guard: another address
 * at the same company domain is on record. Shared mailbox providers never
 * produce the second one — see `src/lib/outreach/domain.ts`.
 */
export const ALREADY_CONTACTED = "ALREADY_CONTACTED" as const;
export const ALREADY_CONTACTED_DOMAIN = "ALREADY_CONTACTED_DOMAIN" as const;

export type OutreachBlockReason =
  | typeof ALREADY_CONTACTED
  | typeof ALREADY_CONTACTED_DOMAIN;

/**
 * What the imported legacy history knows about one address.
 *
 * `matchedOn` records WHICH identity matched, because the two guards are not
 * equally strong: the address is PEPA's canonical identity, and the domain is a
 * secondary protection that is suppressed for shared mailbox providers.
 */
export interface HistoricalContact {
  matchedOn: "email" | "domain";
  normalizedEmail: string;
  normalizedDomain: string | null;
  company: string | null;
  /** How many legacy emails went to this address, as exported. */
  contactCount: number;
  firstContactAt: string | null;
  lastContactAt: string | null;
  /** `historical_import` today. Carried so the reason can name its origin. */
  source: string;
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
  /**
   * Position in this lead's outreach sequence: 0 is the initial outreach, 1 is
   * follow-up #1, and so on. Persisted rather than derived, so the chain can be
   * read back without counting anything.
   */
  sequence_number: number;
  /** The message this one follows. Null for an initial outreach. */
  parent_message_id: string | null;
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

export type OutreachKind = "main" | "follow-up";

/** One outreach email stored for a lead, together with where it sits in the
 * lead's outreach sequence. */
export interface LeadOutreachEmail {
  message: OutreachMessage;
  /** "main" = sequence 0, "follow-up" = sequence 1. */
  kind: OutreachKind;
}

export interface DuplicateCheckResult {
  state: DuplicateState;
  normalizedEmail: string;
  lead: Lead | null;
  /** Total outreach messages ever attached to the lead. */
  messageCount: number;
  /** Only messages that actually left the outbox (status sent/follow_up/replied). */
  sentCount: number;
  lastContactedAt: string | null;
  /**
   * Imported legacy history for this address, or null when there is none.
   *
   * This is what lets the lead pipeline answer "may this address be contacted
   * at all?" for an address that has never had a Pep-generated message, which
   * is the common case after the historical import.
   */
  historicalContact: HistoricalContact | null;
  /**
   * May a NEW cold outreach be created for this address?
   *
   * False only for a permanent refusal — an address or company domain already on
   * record. A finite cooldown is NOT expressed here: it belongs to the send
   * transition, which is the only thing that can enforce it.
   */
  canContact: boolean;
  /** Why `canContact` is false. Null when outreach is allowed. */
  blockReason: OutreachBlockReason | null;
}

export interface OutreachHistoryRow extends Lead {
  latestSubject: string | null;
  latestMessageStatus: LeadStatus | null;
  latestMessageAt: string | null;
  messageCount: number;
  /** Highest follow-up number already notified through a channel, if any. */
  lastFollowupNotifiedNumber: number | null;
  lastFollowupNotifiedAt: string | null;
  /**
   * True while the lead's primary outreach (sequence 0) is still an
   * unsent draft — the only state in which the lead may be deleted.
   * A lead whose primary went out keeps its history and cannot be
   * deleted, even when a newer follow-up row is still a draft.
   */
  unsent: boolean;
  /** The main outreach email (sequence 0) or null when none is stored yet. */
  mainEmail?: LeadOutreachEmail | null;
  /** The follow-up email (sequence 1) or null when none is stored yet. */
  followUpEmail?: LeadOutreachEmail | null;
}

export interface ServiceResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}