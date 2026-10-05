"use client";

import { daysAgo, DUPLICATE_LABEL, formatDate, formatDateTime } from "@/lib/format";
import type { DuplicateCheckResult } from "@/lib/types";

/** Monochrome: severity by ink density, new → contacted goes light to solid. */
const TONE: Record<string, string> = {
  new: "border-midnight bg-midnight-faint text-midnight",
  existing: "border-midnight bg-midnight/15 text-midnight",
  contacted: "border-midnight bg-midnight text-cream",
};

interface DuplicateNoticeProps {
  result: DuplicateCheckResult | null;
  pending: boolean;
  error: string | null;
}

/**
 * The imported legacy history, in the operator's language.
 *
 * Informational only. The backend refuses the send regardless of what this
 * renders, so there is deliberately no control here: a lead is never marked
 * contacted by hand, and nothing on this badge can be dismissed into permission.
 */
function HistoricalLine({ contact }: { contact: NonNullable<DuplicateCheckResult["historicalContact"]> }) {
  return (
    <span className="font-medium">
      {contact.matchedOn === "domain"
        ? `Company domain already contacted`
        : `Already contacted`}
      {` · Last contacted: ${formatDate(contact.lastContactAt)}`}
      {` · Contacts: ${contact.contactCount}`}
      {contact.company ? ` · ${contact.company}` : ""}
      {` — a new cold outreach to this ${contact.matchedOn === "domain" ? "company" : "address"} is blocked.`}
    </span>
  );
}

export function DuplicateNotice({ result, pending, error }: DuplicateNoticeProps) {
  if (error) {
    return (
      <div className="notice notice-alarm">
        {error}
      </div>
    );
  }

  if (pending) {
    return (
      <div className="notice opacity-70">
        Checking Supabase for duplicates…
      </div>
    );
  }

  if (!result) return null;

  const { state, lead, messageCount, sentCount, lastContactedAt, historicalContact } = result;
  const ago = daysAgo(lastContactedAt);

  return (
    <div
      className={`rounded-[1.25rem] border-[3px] px-4 py-3 shadow-[3px_3px_0_0_var(--color-midnight)] ${TONE[state]}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-black uppercase tracking-wide">
          {DUPLICATE_LABEL[state]}
        </span>
        <span className="font-mono text-xs break-all opacity-80">
          {result.normalizedEmail}
        </span>
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

        {historicalContact ? (
          <div className="mt-1 text-xs opacity-90">
            <HistoricalLine contact={historicalContact} />
          </div>
        ) : null}

        {state === "contacted" && !historicalContact && (
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