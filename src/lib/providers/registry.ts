import type { EmailProvider, NotificationService } from "./types";

/**
 * Registry for the transports added in V2. It is intentionally empty: the send
 * button reads it to explain *why* sending is unavailable instead of silently
 * doing nothing.
 *
 * To add Gmail:
 *   1. implement `EmailProvider` in `src/lib/providers/gmail.ts`
 *   2. `registerEmailProvider(new GmailProvider())` at module scope
 *   3. the send button picks it up — no UI changes needed.
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