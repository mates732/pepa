import { connection } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { resolveActionToken } from "@/lib/services/action-token-service";
import { Dashboard } from "@/components/dashboard";
import { SetupNotice } from "@/components/setup-notice";

export const metadata = {
  title: "PEPA · Outreach Tool",
};

/**
 * The authenticated end of a Telegram notification link (`?followup=<token>`).
 *
 * The rules these tests' contract encodes:
 *
 *   * the session gate runs before the token is read;
 *   * the URL contributes nothing but the opaque token — a crafted
 *     `message`/`id` parameter is ignored, the id comes from the token's own
 *     digest;
 *   * a token that does not resolve (tampered, expired, purpose-less, slot 0)
 *     opens nothing rather than guessing.
 *
 * Only the resolved message id crosses to the Dashboard; the panel then loads
 * the full detail through the ordinary authenticated action.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ followup?: string | string[] }>;
}) {
  await connection();
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  const params = (await searchParams) ?? {};
  // Repeated parameters resolve exactly one token, and it is the first — never
  // "the last one wins".
  const rawToken = Array.isArray(params.followup) ? params.followup[0] : params.followup;

  let initialFollowUpId: string | null = null;
  if (rawToken) {
    const resolved = await resolveActionToken(rawToken, "followup_composer");
    const outreach = resolved.ok && resolved.data ? resolved.data.outreach : null;
    // Slot 0 is not a follow-up; the composer path owns those tokens instead.
    if (outreach && Number(outreach.sequence_number ?? 0) > 0) {
      initialFollowUpId = String(outreach.id);
    }
  }

  return <Dashboard initialFollowUpId={initialFollowUpId} />;
}
