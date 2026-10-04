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
 *
 * Opening this page records nothing: no status, no `sent_at`, no counter, no
 * schedule. The send transition stays an explicit, separate action behind the
 * authenticated quality gate.
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
  // The token usually carries a follow-up row (the Phase 8A notification link),
  // and then that row's own `sequence_number` is the number to show. Only a token
  // that anchors on an initial outreach has to fall back to the counter, because
  // in that case no follow-up has been written yet.
  const attempt =
    outreach && outreach.sequence_number > 0 ? outreach.sequence_number : lead.followup_count + 1;
  const since = daysAgo(lead.last_contacted_at);
  const channel = getNotificationService();

  // Lets the operator re-mint this exact deep link without guessing tokens.
  const deepLink = await buildDeepLink(token);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-10">
      <header className="mb-6">
        <h1 className="heading-sticker text-center text-xl text-midnight">
          PEPA the Outman
        </h1>
        <p className="mt-1 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-midnight-soft">
          Follow-up #{attempt}
        </p>
      </header>

      <section className="sticker">
        <div className="space-y-1 border-b-[3px] border-midnight px-5 py-4">
          <h2 className="heading-sticker text-lg text-midnight">
            {lead.company_name || lead.contact_name || lead.email}
          </h2>
          <p className="font-mono text-xs break-all text-midnight-soft">{lead.email}</p>
          <p className="pt-1 text-xs text-midnight-soft">
            Last contact: {formatDateTime(lead.last_contacted_at)}
            {since !== null ? ` (${since} day${since === 1 ? "" : "s"} ago)` : ""}
          </p>
          <p className="text-xs text-midnight-soft">
            Previous outreach messages: {lead.followup_count} · deep link valid until{" "}
            {formatDateTime(resolved.data.expiresAt)}
          </p>
        </div>

        <div className="p-5">
          <FollowUpEditor
            token={token}
            recipient={lead.email}
            subject={outreach?.subject ?? defaultFollowUpSubject(lead.company_name)}
            body={outreach?.body ?? ""}
            savedMessageId={outreach?.id ?? null}
          />

          <div className="notice mt-5 text-xs opacity-80">
            Sending is not wired up yet — the EmailProvider implementation lands in a later
            phase. Use <span className="font-medium">Save</span> to keep this draft, then
            review it in the dashboard.
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-midnight-soft">
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