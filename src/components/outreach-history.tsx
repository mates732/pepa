"use client";

import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OutreachHistoryRow } from "@/lib/types";

interface OutreachHistoryProps {
  rows: OutreachHistoryRow[];
  onLoadIntoComposer: (row: OutreachHistoryRow) => void;
}

export function OutreachHistory({ rows, onLoadIntoComposer }: OutreachHistoryProps) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white shadow-sm">
      <header className="flex items-baseline justify-between border-b border-neutral-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">3 · Outreach history</h2>
        <span className="text-xs text-neutral-500">{rows.length} leads</span>
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-500">
          No leads yet. Paste an outreach block above and save it as a draft.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-[11px] uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-2 font-medium">Company / recipient</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Last contacted</th>
                <th className="px-4 py-2 text-right font-medium">Follow-ups</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-neutral-50 align-middle last:border-0 hover:bg-neutral-50"
                >
                  <td className="max-w-[200px] px-4 py-2">
                    <div className="truncate font-medium text-neutral-900">
                      {row.company_name || row.contact_name || "—"}
                    </div>
                    {row.contact_name && row.company_name ? (
                      <div className="truncate text-xs text-neutral-500">{row.contact_name}</div>
                    ) : null}
                  </td>
                  <td className="max-w-[220px] px-4 py-2">
                    <span className="block truncate font-mono text-xs text-neutral-700">
                      {row.email}
                    </span>
                  </td>
                  <td className="max-w-[260px] px-4 py-2">
                    <span className="block truncate text-neutral-800">
                      {row.latestSubject || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap text-neutral-600">
                    {formatDateTime(row.last_contacted_at)}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-neutral-600 tabular-nums">
                    {row.followup_count}
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap text-neutral-600">
                    {formatDate(row.created_at)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onLoadIntoComposer(row)}
                      className="rounded border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
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