import { connection } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { loadOutreachDraftRows } from "@/app/actions";
import { DraftsListClient } from "@/components/drafts-list-client";
import { SetupNotice } from "@/components/setup-notice";

export const metadata = {
  title: "PEPA · Drafts",
};

export default async function DraftsPage() {
  await connection();
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  const result = await loadOutreachDraftRows();
  const drafts = result.ok ? result.drafts : [];
  const error = result.ok ? null : result.error;

  return <DraftsListClient initialDrafts={drafts} initialError={error} />;
}