"use client";

import { groupActivityByDay } from "@/lib/outreach/activity-days";
import { formatTime } from "@/lib/format";
import type { OutreachActivityItem } from "@/lib/services/outreach-activity-service";

/**
 * Outreach Activity — the list.
 *
 * A chronological record of outreach PEPA actually recorded as SENT. Every row
 * is an `outreach_messages` row with `status = 'sent'`, in the order the server
 * decided; the client neither queries nor re-derives.
 *
 * What is deliberately absent:
 *
 *   * no "mark unsent", delete or edit control — Activity is an audit surface,
 *     and sent outreach is immutable here (Part K). The only action available is
 *     the read-only Gmail hand-off on the detail view.
 *   * no counters. `followup_count` is not consulted, so a lead whose follow-ups
 *     predate the sequence model contributes nothing rather than a fabricated
 *     row.
 *   * no search. Phase 5 is a chronological window; filtering is later work.
 *
 * The day headings come from `outreach/activity-days.ts`, which groups in the
 * reader's local calendar day — the same zone every other timestamp in PEPA is
 * already rendered in.
 */

interface OutreachActivityProps {
  activity: OutreachActivityItem[];
  onSelect: (messageId: string) => void;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  /** True when the server's window is full, so older sends may exist. */
  truncated: boolean;
  limit: number;
}

function leadName(item: OutreachActivityItem): string {
  return item.lead.company_name || item.lead.contact_name || item.lead.email;
}

/**
 * First line of the subject, so a long line cannot dominate the row.
 *
 * Preview only — the exact subject is always one click away on the detail view,
 * and nothing here replaces the stored value.
 */
function subjectPreview(subject: string | null): string {
  if (!subject) return "No subject recorded";
  const firstLine = subject.split("\n").find((line) => line.trim().length > 0);
  const text = (firstLine ?? subject).trim();
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

export function OutreachActivity({
  activity,
  onSelect,
  loading,
  error,
  selectedId,
  truncated,
  limit,
}: OutreachActivityProps) {
  const groups = groupActivityByDay(activity, (item) => item.message.sent_at);

  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          <span className="chip chip-solid mr-2 align-middle">5</span>
          Activity
        </h2>
        <span className="chip">{loading ? "Loading…" : `${activity.length} sent`}</span>
      </header>

      {error ? (
        <p className="m-5 notice notice-alarm">{error}</p>
      ) : loading ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
          Loading activity…
        </p>
      ) : activity.length === 0 ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
          {/* "No outreach sent yet", not "no activity exists": drafts and
              unsent follow-ups may well exist, they are simply not activity. */}
          No outreach sent yet. Activity lists only messages recorded as sent —
          drafts and unsent follow-ups are not shown here.
        </p>
      ) : (
        <div className="space-y-5 p-4">
          {groups.map((group) => (
            <section key={group.key}>
              <h3 className="field-label mb-2">{group.label}</h3>
              <ul className="space-y-2">
                {group.items.map((item) => {
                  const id = item.message.id;
                  const isSelected = id === selectedId;

                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => onSelect(id)}
                        aria-current={isSelected ? "true" : undefined}
                        className={`flex w-full min-w-0 items-start gap-3 rounded-[1rem] border-[3px] px-3 py-2.5 text-left transition-colors ${
                          isSelected
                            ? "border-midnight bg-midnight-faint/60"
                            : "border-midnight-line bg-paper hover:bg-midnight-faint/40"
                        }`}
                      >
                        {/* Every row here is a recorded send, so the tick is a
                            statement of fact rather than a state indicator. */}
                        <span aria-hidden className="shrink-0 pt-0.5 text-base leading-none text-midnight">
                          ✓
                        </span>

                        <span className="shrink-0 pt-0.5 font-mono text-xs font-bold tabular-nums text-midnight">
                          {formatTime(item.message.sent_at)}
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold text-midnight">
                            {leadName(item)}
                          </span>
                          <span className="block truncate text-xs font-semibold text-midnight-soft">
                            {item.typeLabel}
                          </span>
                          <span className="block truncate font-mono text-xs text-midnight-soft">
                            {item.message.recipient_email}
                          </span>
                          <span className="block truncate text-xs italic text-midnight-soft">
                            {subjectPreview(item.message.subject)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {/* Honest about the window. The query is bounded, so the list must not
              imply it is the complete lifetime history. */}
          <p className="pt-1 text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
            {truncated
              ? `Showing the ${limit} most recent sends. Older sends are not loaded.`
              : `Showing every send recorded so far (up to ${limit}).`}
          </p>
        </div>
      )}
    </section>
  );
}