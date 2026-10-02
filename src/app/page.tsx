import { connection } from "next/server";

import { logout } from "@/app/auth-actions";
import { Dashboard } from "@/components/dashboard";
import { SetupNotice } from "@/components/setup-notice";
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

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            PEPA · Outreach Tool
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Paste → Parse → Check duplicate → Review → Save/Send
          </p>
        </div>

        {/* A form (not fetch) so the HttpOnly cookie is cleared by the server. */}
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            Sign out
          </button>
        </form>
      </header>

      <Dashboard initialRows={rows} />
    </main>
  );
}