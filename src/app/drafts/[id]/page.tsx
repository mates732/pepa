import { connection } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { loadDraftById } from "@/app/load-draft-action";
import { DraftDetailClient } from "@/components/draft-detail-client";
import { SetupNotice } from "@/components/setup-notice";
import { notFound } from "next/navigation";

export const metadata = {
  title: "PEPA · Draft Detail",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function DraftDetailPage({ params }: Props) {
  await connection();
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  const { id } = await params;
  const result = await loadDraftById(id);

  if (!result.ok) {
    notFound();
  }

  return <DraftDetailClient initialDraft={result} />;
}