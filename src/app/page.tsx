import { connection } from "next/server";

import { logout } from "@/app/auth-actions";
import { devToolsEnabled } from "@/app/dev-actions";
import { Dashboard } from "@/components/dashboard";
import { SetupNotice } from "@/components/setup-notice";
import { TelegramTestButton } from "@/components/telegram-test-button";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { resolveActionToken } from "@/lib/services/action-token-service";
import { listOutreachHistory } from "@/lib/services/outreach-service";
import type { OutreachHistoryRow } from "@/lib/types";

export const metadata = {
  title: "PEPA · Outreach Tool",
};

export default async function Page({ searchParams }: PageProps<"/">) {
  // Always render at request time: the dashboard reflects live database state.
  await connection();

  // Secure check — the session is verified here regardless of Proxy. Everything
  // below, including token resolution, runs only for an authenticated operator.
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  const history = await listOutreachHistory();
  if (!history.ok) {
    const detail = history.error ?? "Could not read the outreach history.";
    return (
      <SetupNotice
        missing={[]}
        detail={detail}
        hint={
          /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(detail)
            ? "Supabase could not be reached. Check NEXT_PUBLIC_SUPABASE_URL and that the project is running."
            : undefined
        }
      />
    );
  }

  const rows = (history.data ?? []) as OutreachHistoryRow[];
  const showDevTools = await devToolsEnabled();

  // Phase 8B: a Telegram notification lands here as `?followup=<token>`.
  //
  // The token is resolved on the server, exactly as `/followup/<token>` does, so
  // the browser is never asked to supply or to trust a message id. Only the id
  // that the token's own digest resolves to is used, which is what makes this
  // incapable of reaching another lead or another message.
  //
  // A token that does not resolve — expired, tampered, or minted for something
  // that is not a follow-up — simply opens nothing. The dashboard is not a
  // second deep-link surface: there is no error page here to navigate to, and
  // refusing to guess keeps this route from becoming one.
  const params = await searchParams;
  const requested = Array.isArray(params.followup) ? params.followup[0] : params.followup;
  let initialFollowUpId: string | null = null;

  if (requested) {
    const resolved = await resolveActionToken(requested, "followup_composer");
    // Slot 0 is an initial outreach, not a follow-up: the Phase 4C detail is
    // about follow-ups, so those keep their existing behaviour and open nothing.
    if (resolved.ok && resolved.data?.outreach && resolved.data.outreach.sequence_number > 0) {
      initialFollowUpId = resolved.data.outreach.id;
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            aria-hidden
            className="tilt grid h-12 w-12 shrink-0 place-items-center rounded-[1.1rem] border-[3px] border-midnight bg-midnight text-lg font-black text-cream shadow-[4px_4px_0_0_var(--color-midnight)]"
          >
            P
          </div>
          <div>
            <h1 className="heading-sticker text-2xl text-midnight">
              PEPA the Outman
            </h1>
            <p className="mt-0.5 text-xs font-bold uppercase tracking-[0.18em] text-midnight-soft">
              Paste · Parse · Check · Review
            </p>
          </div>
        </div>

        {/* A form (not fetch) so the HttpOnly cookie is cleared by the server. */}
        <div className="flex items-start gap-2">
          {showDevTools ? <TelegramTestButton /> : null}
          <form action={logout}>
            <button type="submit" className="btn btn-sm">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <Dashboard initialRows={rows} initialFollowUpId={initialFollowUpId} />
    </main>
  );
}