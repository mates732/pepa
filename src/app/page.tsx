import { connection } from "next/server";

import { logout } from "@/app/auth-actions";
import { devToolsEnabled } from "@/app/dev-actions";
import { Dashboard } from "@/components/dashboard";
import { SetupNotice } from "@/components/setup-notice";
import { TelegramTestButton } from "@/components/telegram-test-button";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { listOutreachHistory } from "@/lib/services/outreach-service";
import type { OutreachHistoryRow } from "@/lib/types";

export const metadata = {
  title: "PEPA · Outreach Tool",
};

export default async function Page() {
  // Always render at request time: the dashboard reflects live database state.
  await connection();

  // Secure check — the session is verified here regardless of Proxy.
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

      <Dashboard initialRows={rows} />
    </main>
  );
}