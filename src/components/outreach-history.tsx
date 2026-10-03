"use client";

import { FollowUpState } from "@/components/follow-up-state";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OutreachHistoryRow } from "@/lib/types";

interface OutreachHistoryProps {
  rows: OutreachHistoryRow[];
  onLoadIntoComposer: (row: OutreachHistoryRow) => void;
}

export function OutreachHistory({ rows, onLoadIntoComposer }: OutreachHistoryProps) {
  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          <span className="chip chip-solid mr-2 align-middle">3</span>
          Outreach history
        </h2>
        <span className="chip">{rows.length} leads</span>
      </header>

      {rows.length === 0 ? (
        <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
          No leads yet. Paste an outreach block above and save it as a draft.
        </p>
      ) : (
        <div className="overflow-x-auto p-2">
          <table className="w-full min-w-[1000px] border-collapse text-sm">
            <thead>
              <tr className="border-b-[3px] border-midnight text-left text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
                <th className="px-4 py-3">Company / recipient</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Subject</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Follow-up</th>
                <th className="px-4 py-3">Last contacted</th>
                <th className="px-4 py-3 text-right">Follow-ups</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-dashed border-midnight-line align-middle last:border-0 hover:bg-midnight-faint/50"
                >
                  <td className="max-w-[200px] px-4 py-3">
                    <div className="truncate font-bold text-midnight">
                      {row.company_name || row.contact_name || "—"}
                    </div>
                    {row.contact_name && row.company_name ? (
                      <div className="truncate text-xs text-midnight-soft">
                        {row.contact_name}
                      </div>
                    ) : null}
                  </td>
                  <td className="max-w-[220px] px-4 py-3">
                    <span className="block truncate font-mono text-xs text-midnight-soft">
                      {row.email}
                    </span>
                  </td>
                  <td className="max-w-[260px] px-4 py-3">
                    <span className="block truncate text-midnight">
                      {row.latestSubject || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3">
                    <FollowUpState row={row} />
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap text-midnight-soft">
                    {formatDateTime(row.last_contacted_at)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs font-bold text-midnight tabular-nums">
                    {row.followup_count}
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap text-midnight-soft">
                    {formatDate(row.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onLoadIntoComposer(row)}
                      className="btn btn-sm"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}