"use client";

import { daysAgo, DUPLICATE_LABEL, formatDateTime } from "@/lib/format";
import type { DuplicateCheckResult } from "@/lib/types";

const TONE: Record<string, string> = {
  new: "border-emerald-300 bg-emerald-50 text-emerald-900",
  existing: "border-sky-300 bg-sky-50 text-sky-900",
  contacted: "border-red-400 bg-red-50 text-red-900",
};

interface DuplicateNoticeProps {
  result: DuplicateCheckResult | null;
  pending: boolean;
  error: string | null;
}

export function DuplicateNotice({ result, pending, error }: DuplicateNoticeProps) {
  if (error) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        {error}
      </div>
    );
  }

  if (pending) {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500">
        Checking Supabase for duplicates…
      </div>
    );
  }

  if (!result) return null;

  const { state, lead, messageCount, sentCount, lastContactedAt } = result;
  const ago = daysAgo(lastContactedAt);

  return (
    <div className={`rounded-md border px-3 py-2 ${TONE[state]}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-bold tracking-wide">{DUPLICATE_LABEL[state]}</span>
        <span className="font-mono text-xs break-all">{result.normalizedEmail}</span>
        {lead?.company_name ? (
          <span className="text-xs opacity-80">{lead.company_name}</span>
        ) : null}
      </div>

      <div className="mt-1 text-xs opacity-90">
        {state === "new" && "No lead record for this address. One will be created on save."}

        {state === "existing" && (
          <>
            Lead exists but has never been contacted
            {messageCount > 0 ? ` · ${messageCount} draft(s) saved` : ""}.
          </>
        )}

        {state === "contacted" && (
          <span className="font-medium">
            Last contacted {formatDateTime(lastContactedAt)}
            {ago !== null ? ` (${ago} day${ago === 1 ? "" : "s"} ago)` : ""} ·{" "}
            {messageCount} previous outreach message{messageCount === 1 ? "" : "s"} ·{" "}
            {sentCount} actually sent. Review before continuing.
          </span>
        )}
      </div>
    </div>
  );
}