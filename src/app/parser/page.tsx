import { connection } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { ParserClient } from "@/components/parser-client";
import { SetupNotice } from "@/components/setup-notice";

export const metadata = {
  title: "PEPA · Paste Emails",
};

export default async function ParserPage() {
  await connection();
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  return <ParserClient />;
}