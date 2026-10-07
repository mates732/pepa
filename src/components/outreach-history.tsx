"use client";

import { useEffect, useRef, useState } from "react";

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
   * Delete a lead from history and the database ("Smazat z historie").
   *
   * Where this is supplied, EVERY row gains the Smazat control — sent
   * leads included; the confirmation states the removal is permanent.
   * Upravit stays gated on `row.unsent`: only a draft may be edited,
   * but any lead may be removed. Deletion is refused server-side only
   * for the separate guarded action; this callback goes through the
   * unguarded `deleteLeadFromHistory` path.
   */
  onDelete?: (row: OutreachHistoryRow) => void;
  /** Row whose deletion is in flight. */
  deletingRowId?: string | null;
  /** Bulk actions */
  onBulkDelete?: (leadIds: string[]) => void;
  onBulkMarkSent?: (leadIds: string[]) => void;
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
}

export function OutreachHistory({
  rows,
  onLoadIntoComposer,
  onOpenDetail,
  openingDetailId,
  openingComposerRowId = null,
  onDelete,
  deletingRowId = null,
  onBulkDelete,
  onBulkMarkSent,
  selectedIds = [],
  onSelectionChange,
}: OutreachHistoryProps) {
  // The lead awaiting confirmation in the delete dialog. null means
  // no dialog is open.
  const [confirmDeleteRow, setConfirmDeleteRow] = useState<OutreachHistoryRow | null>(
    null,
  );
  // Row with open dropdown menu
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null);
  // Select all checkbox ref for indeterminate state
  const selectAllRef = useRef<HTMLInputElement>(null);

  // Selection is fully controlled via props - no internal state needed
  const selection = new Set(selectedIds);

  // Sync indeterminate state when selection changes
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selection.size > 0 && selection.size < rows.length;
    }
  }, [selection.size, rows.length]);

  // Escape dismisses the confirmation, exactly like Zrušit.
  useEffect(() => {
    if (!confirmDeleteRow) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setConfirmDeleteRow(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmDeleteRow]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-dropdown]")) {
        setOpenMenuRowId(null);
      }
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const handleSelectRow = (leadId: string, checked: boolean) => {
    const newSelection = new Set(selection);
    if (checked) newSelection.add(leadId);
    else newSelection.delete(leadId);
    onSelectionChange?.(Array.from(newSelection));
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allIds = new Set(rows.map((r) => r.id));
      onSelectionChange?.(Array.from(allIds));
    } else {
      onSelectionChange?.([]);
    }
    // Update indeterminate state via ref
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = false;
    }
  };

  const toggleMenu = (rowId: string) => {
    setOpenMenuRowId((prev) => (prev === rowId ? null : rowId));
  };

  const handleMenuAction = (
    action: "edit" | "sequence" | "open" | "delete",
    row: OutreachHistoryRow,
  ) => {
    setOpenMenuRowId(null);
    switch (action) {
      case "edit":
        onLoadIntoComposer(row);
        break;
      case "sequence":
        onOpenDetail(row);
        break;
      case "open":
        onLoadIntoComposer(row);
        break;
      case "delete":
        setConfirmDeleteRow(row);
        break;
    }
  };

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
                  <th className="px-4 py-3 w-10">
                    {rows.length > 0 && (
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={selection.size === rows.length && rows.length > 0}
                        onChange={(e) => handleSelectAll(e.target.checked)}
                        className="field"
                      />
                    )}
                  </th>
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
                {rows.map((row) => {
                  const isSelected = selection.has(row.id);
                  return (
                    <tr
                      key={row.id}
                      className={`border-b border-dashed border-midnight-line align-middle last:border-0 hover:bg-midnight-faint/50 ${isSelected ? "bg-midnight-faint/20" : ""}`}
                    >
                      <td className="px-4 py-3 w-10 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => handleSelectRow(row.id, e.target.checked)}
                          className="field"
                        />
                      </td>
                      <td className="max-w-[200px] px-4 py-3">
                        <div className="truncate font-bold text-midnight">
                          {row.company_name || row.contact_name || "\u2014"}
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
                          {row.latestSubject || "\u2014"}
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
                        <div className="flex items-center justify-end gap-2" data-dropdown>
                          {/* Dropdown menu button */}
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => toggleMenu(row.id)}
                              disabled={deletingRowId === row.id}
                              className="btn btn-sm"
                              aria-haspopup="true"
                              aria-expanded={openMenuRowId === row.id}
                            >
                              \u22EE
                            </button>
                            {openMenuRowId === row.id && (
                              <div className="absolute right-0 top-full mt-1 z-20 sticker min-w-[140px] py-1 shadow-lg border-2 border-midnight">
                                {row.unsent && (
                                  <button
                                    type="button"
                                    onClick={() => handleMenuAction("edit", row)}
                                    disabled={openingComposerRowId === row.id || deletingRowId === row.id}
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-midnight-faint"
                                  >
                                    Upravit
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleMenuAction("sequence", row)}
                                  disabled={openingDetailId === row.id || deletingRowId === row.id}
                                  className="w-full px-3 py-2 text-left text-sm hover:bg-midnight-faint"
                                >
                                  Sequence
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleMenuAction("open", row)}
                                  disabled={openingComposerRowId === row.id || deletingRowId === row.id}
                                  className="w-full px-3 py-2 text-left text-sm hover:bg-midnight-faint"
                                >
                                  Open
                                </button>
                                {onDelete && (
                                  <button
                                    type="button"
                                    onClick={() => handleMenuAction("delete", row)}
                                    disabled={deletingRowId === row.id}
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-midnight-faint text-alarm"
                                  >
                                    Smazat
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                )}
              </tbody>
            </table>

            {/* Bulk action bar */}
            {selection.size > 0 && (
              <div className="border-t-[3px] border-dashed border-midnight-line p-3 flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-midnight">
                  {selection.size} selected
                </span>
                {onBulkMarkSent && (
                  <button
                    type="button"
                    onClick={() => onBulkMarkSent?.(Array.from(selection))}
                    disabled={deletingRowId !== null}
                    className="btn btn-sm btn-primary"
                  >
                    Mark as sent
                  </button>
                )}
                {onBulkDelete && (
                  <button
                    type="button"
                    onClick={() => onBulkDelete?.(Array.from(selection))}
                    disabled={deletingRowId !== null}
                    className="btn btn-sm btn-alarm"
                  >
                    Smazat vybrané
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleSelectAll(false)}
                  className="btn btn-sm"
                >
                  Zrušit výběr
                </button>
              </div>
            )}
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
              Lead bude odstraněn z historie i databáze včetně jeho draftů a
              pending follow-upů. Tuto akci nelze vrátit.
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