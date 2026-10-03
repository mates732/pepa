"use client";

import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import type { FollowUpListItem } from "@/lib/services/follow-up-sequence-service";

/**
 * Follow-ups workspace — list.
 *
 * Renders only real `outreach_messages` rows with `sequence_number > 0`, in the
 * order the server decided. The client never queries and never re-derives:
 * position comes from `sequence_number`, and `attention` (due → unsent → sent)
 * comes from the service so the grouping rule lives in exactly one place.
 *
 * Nothing here is inferred from `leads.followup_count`. A lead whose follow-ups
 * predate the sequence model simply has no rows here, and the empty state says
 * so honestly rather than implying no follow-up ever existed.
 */

interface FollowUpWorkspaceProps {
  followUps: FollowUpListItem[];
  onSelect: (messageId: string) => void;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
}

/** `Follow-up #2` — from `sequence_number`, never from a counter. */
function sequenceLabel(sequenceNumber: number): string {
  return `Follow-up #${sequenceNumber}`;
}

function leadName(item: FollowUpListItem): string {
  return item.lead.company_name || item.lead.contact_name || item.lead.email;
}

/** The one line that says what actually happened to this message. */
function stateLine(item: FollowUpListItem): string {
  if (item.message.sent_at) return `Sent ${formatDateTime(item.message.sent_at)}`;
  if (item.message.status === "sent") return "Sent";

  const label = item.message.status === "ready" ? "Ready" : "Draft";
  if (item.due && item.dueAt) return `${label} · Due ${formatDate(item.dueAt)}`;
  if (item.due) return `${label} · Due`;
  return label;
}

export function FollowUpWorkspace({
  followUps,
  onSelect,
  loading,
  error,
  selectedId,
}: FollowUpWorkspaceProps) {
  const groups = [
    { key: 0, title: "Needs attention" },
    { key: 1, title: "Not sent yet" },
    { key: 2, title: "Sent" },
  ] as const;

  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          <span className="chip chip-solid mr-2 align-middle">4</span>
          Follow-ups
        </h2>
        <span className="chip">{loading ? "Loading…" : `${followUps.length} recorded`}</span>
      </header>

      {error ? (
        <p className="m-5 notice notice-alarm">{error}</p>
      ) : loading ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
          Loading follow-ups…
        </p>
      ) : followUps.length === 0 ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
          {/* "No follow-ups recorded", not "no follow-ups exist": a lead can
              have `followup_count > 0` with nothing stored, and those cannot be
              shown here without inventing them. */}
          No follow-ups recorded. A follow-up appears here once it is saved as a
          real message — historical follow-ups sent before this existed are not
          stored and cannot be listed.
        </p>
      ) : (
        <div className="space-y-5 p-4">
          {groups.map(({ key, title }) => {
            const items = followUps.filter((item) => item.attention === key);
            if (items.length === 0) return null;

            return (
              <section key={key}>
                <h3 className="field-label mb-2">{title}</h3>
                <ul className="space-y-2">
                  {items.map((item) => {
                    const id = item.message.id;
                    const isSelected = id === selectedId;

                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => onSelect(id)}
                          aria-current={isSelected ? "true" : undefined}
                          className={`flex w-full min-w-0 items-center gap-3 rounded-[1rem] border-[3px] px-3 py-2.5 text-left transition-colors ${
                            isSelected
                              ? "border-midnight bg-midnight-faint/60"
                              : "border-midnight-line bg-paper hover:bg-midnight-faint/40"
                          }`}
                        >
                          {/* Sent is the only state that has actually happened. */}
                          <span aria-hidden className="shrink-0 text-base leading-none text-midnight">
                            {item.message.sent_at ? "✓" : "○"}
                          </span>

                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-bold text-midnight">
                              {leadName(item)}
                            </span>
                            <span className="block truncate text-xs text-midnight-soft">
                              {sequenceLabel(item.message.sequence_number)} · {stateLine(item)}
                            </span>
                          </span>

                          <span className="hidden shrink-0 sm:block">
                            <StatusBadge status={item.message.status} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
