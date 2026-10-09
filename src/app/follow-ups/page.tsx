import { connection } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { loadFollowUps } from "@/app/actions";
import { FollowUpsClient } from "@/components/follow-ups-client";
import { SetupNotice } from "@/components/setup-notice";

export const metadata = {
  title: "PEPA · Follow-ups",
};

export default async function FollowUpsPage() {
  await connection();
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  const result = await loadFollowUps();
  const followUps = result.ok ? result.followUps : [];
  const error = result.ok ? null : result.error;

  return <FollowUpsClient initialFollowUps={followUps} initialError={error} />;
}