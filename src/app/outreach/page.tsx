import { connection } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { loadOutreachHistory } from "@/app/actions";
import { OutreachHistoryClient } from "@/components/outreach-history-client";
import { SetupNotice } from "@/components/setup-notice";

export const metadata = {
  title: "PEPA · Outreach History",
};

export default async function OutreachPage() {
  await connection();
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  const result = await loadOutreachHistory();
  const history = result.ok ? result.leads : [];
  const error = result.ok ? null : result.error;

  return <OutreachHistoryClient initialHistory={history} initialError={error} />;
}