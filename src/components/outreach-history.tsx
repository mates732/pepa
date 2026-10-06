"use client";

import { useEffect, useState } from "react";

import { FollowUpState } from "@/components/follow-up-state";
import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OutreachHistoryRow } from "@/lib/types";

interface OutreachHistoryProps {
  rows: OutreachHistoryRow[];
  onLoadIntoComposer: (row: OutreachHistoryRow) => void;
  /**
   * Phase 8F: open this lead's sequence detail.
   *
   * Distinct from `onLoadIntoComposer`, which is unchanged and still loads the
   * row into the composer for editing. This one opens the read-only detail,
   * which is where the "Next follow-up" form lives — reachable for a lead whose
   * newest row is still the sequence-0 draft, because the Follow-ups workspace
   * lists only `sequence_number > 0`.
   */
  onOpenDetail: (row: OutreachHistoryRow) => void;
  openingDetailId: string | null;
  /**
   * Row currently being resolved into the composer.
   *
   * Loading a row is a server round trip now, so the row's own button reports
   * progress and refuses a second click. Optional so existing callers can omit
   * it; the button is simply never then in a loading state.
   */
  openingComposerRowId?: string | null;
  /**
   * Delete an unsent lead. Where this is supplied, every row whose
   * primary outreach is still an unsent draft gains explicit
   * Upravit/Smazat controls. Sent leads never receive them: their
   * history is kept and deletion is refused server-side anyway.
   */
  onDelete?: (row: OutreachHistoryRow) => void;
  /** Row whose deletion is in flight. */
  deletingRowId?: string | null;
}

export function OutreachHistory({
  rows,
  onLoadIntoComposer,
  onOpenDetail,
  openingDetailId,
  openingComposerRowId = null,
  onDelete,
  deletingRowId = null,
}: OutreachHistoryProps) {
  // The lead awaiting confirmation in the delete dialog. null means
  // no dialog is open.
  const [confirmDeleteRow, setConfirmDeleteRow] = useState<OutreachHistoryRow | null>(
    null,
  );

  // Escape dismisses the confirmation, exactly like Zrušit.
  useEffect(() => {
    if (!confirmDeleteRow) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setConfirmDeleteRow(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmDeleteRow]);

  return (
    <>
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
                    <div className="flex items-center justify-end gap-2">
                      {row.unsent && onDelete ? (
                        <>
                          <button
                            type="button"
                            onClick={() => onLoadIntoComposer(row)}
                            disabled={
                              openingComposerRowId === row.id ||
                              deletingRowId === row.id
                            }
                            className="btn btn-sm"
                            title="Edit this unsent lead's recipient, subject and message. Nothing is sent."
                          >
                            {openingComposerRowId === row.id
                              ? "Opening…"
                              : "Upravit"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteRow(row)}
                            disabled={deletingRowId === row.id}
                            className="btn btn-sm"
                            title="Delete this unsent lead, its primary draft and its pending follow-ups."
                          >
                            {deletingRowId === row.id ? "Deleting…" : "Smazat"}
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => onOpenDetail(row)}
                        disabled={
                          openingDetailId === row.id || deletingRowId === row.id
                        }
                        className="btn btn-sm"
                        title="Open this outreach's sequence detail, where the next follow-up can be drafted. Nothing is sent."
                      >
                        {openingDetailId === row.id ? "Opening…" : "Sequence"}
                      </button>
                      <button
                        type="button"
                        onClick={() => onLoadIntoComposer(row)}
                        disabled={
                          openingComposerRowId === row.id || deletingRowId === row.id
                        }
                        className="btn btn-sm"
                      >
                        {openingComposerRowId === row.id ? "Opening…" : "Open"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    {confirmDeleteRow && onDelete ? (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/40 p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) setConfirmDeleteRow(null);
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-lead-title"
          aria-describedby="delete-lead-body"
          className="sticker w-full max-w-md p-6"
        >
          <h3
            id="delete-lead-title"
            className="heading-sticker text-lg text-midnight"
          >
            Smazat tento lead?
          </h3>
          <p className="mt-2 truncate font-mono text-xs text-midnight-soft">
            {confirmDeleteRow.email}
          </p>
          <p id="delete-lead-body" className="mt-3 text-sm text-midnight">
            Tento lead ještě nebyl odeslán. Opravdu ho chcete odstranit?
          </p>
          <p className="mt-3 text-xs text-midnight-soft">
            Smaže se i jeho primární koncept a čekající follow-upy. Lead, který
            už byl odeslán, nelze smazat — jeho historie zůstává.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setConfirmDeleteRow(null)}
            >
              Zrušit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                const target = confirmDeleteRow;
                setConfirmDeleteRow(null);
                onDelete(target);
              }}
            >
              Smazat
            </button>
          </div>
        </div>
      </div>
    ) : null}
  </>
  );
}