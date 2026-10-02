import { FollowUpEditor } from "@/components/follow-up-editor";
import { InvalidDeepLink } from "@/components/invalid-deep-link";
import { verifySession } from "@/lib/auth/dal";
import { buildDeepLink } from "@/lib/config/base-url";
import { daysAgo, formatDateTime } from "@/lib/format";
import { getNotificationService } from "@/lib/providers/registry";
import "@/lib/providers/notifications";
import {
  INVALID_TOKEN_MESSAGE,
  resolveActionToken,
} from "@/lib/services/action-token-service";

/**
 * Deep-link landing page: `/followup/<opaque-token>`.
 *
 * Mobile flow (Telegram → browser):
 *   unauthenticated → Proxy redirects to /login?next=/followup/<token>
 *                    → after login the operator returns straight here
 *   authenticated   → the token is resolved and the composer renders directly
 *
 * The URL contains nothing but a random token. The lead is resolved server-side
 * from the token digest, so `/followup/123` cannot be used to enumerate leads.
 */
export default async function FollowUpPage({ params }: PageProps<"/followup/[token]">) {
  // Server remains the source of truth: Proxy is only an optimistic redirect.
  await verifySession();

  const { token } = await params;
  const resolved = await resolveActionToken(token, "followup_composer");

  if (!resolved.ok || !resolved.data) {
    return <InvalidDeepLink message={resolved.error ?? INVALID_TOKEN_MESSAGE} />;
  }

  const { lead, outreach } = resolved.data;
  const attempt = lead.followup_count + 1;
  const since = daysAgo(lead.last_contacted_at);
  const channel = getNotificationService();

  // Lets the operator re-mint this exact deep link without guessing tokens.
  const deepLink = await buildDeepLink(token);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-center text-sm font-semibold tracking-[0.2em] text-neutral-900 uppercase">
          PEPA the Outman
        </h1>
        <p className="mt-1 text-center text-xs uppercase tracking-widest text-neutral-500">
          Follow-up #{attempt}
        </p>
      </header>

      <section className="rounded-lg border border-neutral-200 bg-white shadow-sm">
        <div className="space-y-1 border-b border-neutral-100 px-4 py-3">
          <h2 className="text-base font-semibold text-neutral-900">
            {lead.company_name || lead.contact_name || lead.email}
          </h2>
          <p className="font-mono text-xs break-all text-neutral-600">{lead.email}</p>
          <p className="pt-1 text-xs text-neutral-500">
            Last contact: {formatDateTime(lead.last_contacted_at)}
            {since !== null ? ` (${since} day${since === 1 ? "" : "s"} ago)` : ""}
          </p>
          <p className="text-xs text-neutral-500">
            Previous outreach messages: {lead.followup_count} · deep link valid until{" "}
            {formatDateTime(resolved.data.expiresAt)}
          </p>
        </div>

        <div className="p-4">
          <FollowUpEditor
            token={token}
            recipient={lead.email}
            subject={outreach?.subject ?? defaultFollowUpSubject(lead.company_name)}
            body={outreach?.body ?? ""}
            savedMessageId={outreach?.id ?? null}
          />

          <div className="mt-4 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-xs text-neutral-500">
            Sending is not wired up yet — the EmailProvider implementation lands in a later
            phase. Use <span className="font-medium">Save</span> to keep this draft, then
            review it in the dashboard.
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
            <span>
              Deep link:{" "}
              <span className="font-mono break-all">{deepLink}</span>
            </span>
            {channel ? (
              <span>
                Notification channel:{" "}
                <span className="font-medium">{channel.id}</span>
              </span>
            ) : (
              <span>Notification channel: not configured</span>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function defaultFollowUpSubject(company: string | null): string {
  return company ? `Follow-up: ${company}` : "Follow-up";
}