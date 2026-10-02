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

/** Telegram (V2). Operator-facing nudges such as "3 follow-ups are due today." */
export interface NotificationService {
  readonly id: string;
  isConfigured(): boolean;
  send(notification: Notification): Promise<void>;
}