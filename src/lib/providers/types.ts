/**
 * Interfaces for the V2 integrations. Nothing here is implemented yet — these
 * exist so the send button, the follow-up engine and the notification channel
 * have a stable contract to code against when they land.
 */

import type { EmailProviderId, Lead, OutreachMessage } from "@/lib/types";

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
}

export interface SendResult {
  provider: EmailProviderId;
  providerMessageId: string | null;
  sentAt: string;
}

/**
 * One transport for outbound mail: Gmail API, Apple Mail (mailto), etc.
 *
 * The send button calls `send()`, then the outreach service persists
 * `provider`, `provider_message_id` and `sent_at` from the result, and bumps
 * the lead's `last_contacted_at` / `next_followup_at`.
 */
export interface EmailProvider {
  readonly id: EmailProviderId;
  readonly label: string;
  /** False when credentials or OS integration are missing. */
  isConfigured(): boolean;
  send(message: OutreachMessage): Promise<SendResult>;
}

export interface DueFollowUp {
  lead: Lead;
  lastMessage: OutreachMessage | null;
  dueAt: string;
  attempt: number;
}

/**
 * Drives `next_followup_at` / `followup_count`. Reads leads whose follow-up is
 * due and either enqueues a message or notifies the operator.
 */
export interface FollowUpService {
  listDue(limit?: number): Promise<DueFollowUp[]>;
  scheduleNext(leadId: string, dueAt: string): Promise<void>;
  /** Called when a reply is detected, so pending follow-ups stop. */
  cancelPending(leadId: string): Promise<void>;
}

export interface Notification {
  title: string;
  body: string;
}

/**
 * A notification that carries a single call to action.
 *
 * Deliberately channel-agnostic: Telegram renders `actionUrl` as an inline button,
 * email would render a link, push would deep-link. The caller (the follow-up
 * engine) owns the URL, which is always an opaque PEPA deep link — no channel
 * ever receives outreach content or a lead id.
 */
export interface ActionNotification extends Notification {
  actionLabel: string;
  actionUrl: string;
}

export interface NotificationService {
  readonly id: string;
  isConfigured(): boolean;
  send(notification: Notification): Promise<void>;
  /** Optional: providers that cannot render an action button may omit it. */
  sendActionNotification?(notification: ActionNotification): Promise<void>;
}
