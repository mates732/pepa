import type { EmailProvider, NotificationService } from "./types";

// Deliberately NOT `server-only`: client components import the
// NOT_CONFIGURED_MESSAGE constant from here. The registered provider
// implementations are the server-only part, and they are constructed in
// src/lib/providers/notifications.ts, which is server-only.

/**
 * Registry for the transports added in V2. The follow-up notification channel
 * is registered here today; the email providers are still intentionally empty.
 *
 * To add Gmail:
 *   1. implement `EmailProvider` in `src/lib/providers/gmail.ts`
 *   2. `registerEmailProvider(new GmailProvider())` at module scope
 *   3. the send button picks it up — no UI changes needed.
 *
 * To add email or push notifications:
 *   implement `NotificationService` and `registerNotificationService()`.
 *   Follow-up logic never learns which channel it is talking to.
 */
const emailProviders = new Map<string, EmailProvider>();
const notificationServices = new Map<string, NotificationService>();

export function registerEmailProvider(provider: EmailProvider): void {
  emailProviders.set(provider.id, provider);
}

export function getEmailProvider(id?: string): EmailProvider | null {
  if (id) return emailProviders.get(id) ?? null;
  return [...emailProviders.values()].find((p) => p.isConfigured()) ?? null;
}

export function listEmailProviders(): EmailProvider[] {
  return [...emailProviders.values()];
}

export function registerNotificationService(service: NotificationService): void {
  notificationServices.set(service.id, service);
}

export function getNotificationService(id?: string): NotificationService | null {
  if (id) return notificationServices.get(id) ?? null;
  return [...notificationServices.values()].find((s) => s.isConfigured()) ?? null;
}

export const NOT_CONFIGURED_MESSAGE =
  "No email provider is configured yet. Gmail and Apple Mail land in V2 — save the draft for now.";