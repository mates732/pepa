"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

import { openGmailCompose } from "@/lib/outreach/open-gmail-compose";
import { deleteOutreachMessage, loadOutreachDraftRows } from "@/app/actions";
import type { OutreachDraftRow } from "@/lib/services/outreach-service";
import { formatDate, sequenceLabel, leadTitle, draftTitle } from "@/lib/utils/date";

interface Notice {
  kind: "info" | "error";
  text: string;
}

interface Props {
  initialDrafts: OutreachDraftRow[];
  initialError: string | null;
}

export function DraftsListClient({ initialDrafts, initialError }: Props) {
  const [drafts, setDrafts] = useState<OutreachDraftRow[]>(initialDrafts);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [openingGmailId, setOpeningGmailId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const loadedRef = useRef(false);

  const loadDrafts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadOutreachDraftRows();
      if (result.ok) {
        setDrafts(result.drafts);
      } else {
        setError(result.error);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loadedRef.current && initialDrafts.length === 0 && !initialError) {
      loadedRef.current = true;
      loadDrafts();
    }
  }, [initialDrafts, initialError, loadDrafts]);

  function handleOpenInGmail(messageId: string, draft: OutreachDraftRow) {
    setOpeningGmailId(messageId);
    setNotice(null);

    openGmailCompose({
      to: draft.message.recipient_email,
      subject: draft.message.subject,
      body: draft.message.body,
    });

    // Navigation happens synchronously in openGmailCompose via window.location.assign().
    // No notice needed — the browser navigates away.
  }

  async function handleDelete(messageId: string) {
    if (!window.confirm("Delete this draft? This cannot be undone.")) return;

    setDeletingId(messageId);
    setNotice(null);
    try {
      const result = await deleteOutreachMessage({ messageId });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setDrafts((current) => current.filter((d) => d.message.id !== messageId));
      setNotice({ kind: "info", text: "Draft deleted." });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="heading-sticker text-2xl text-midnight">Drafts</h1>
        <p className="mt-1 text-sm text-midnight-soft">
          {drafts.length} draft{drafts.length === 1 ? "" : "s"} saved
        </p>
      </header>

      {error && (
        <div className="notice notice-alarm" role="alert">{error}</div>
      )}

      {loading ? (
        <div className="sticker p-8 text-center">
          <p className="text-midnight-soft">Loading drafts…</p>
        </div>
      ) : drafts.length === 0 ? (
        <div className="sticker p-8 text-center">
          <p className="text-midnight-soft mb-4">No drafts yet.</p>
          <a href="/parser" className="btn btn-primary">Paste Emails</a>
        </div>
      ) : (
        <div className="sticker">
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full border-collapse text-sm min-w-[640px]">
              <thead>
                <tr className="border-b-[3px] border-midnight text-left text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
                  <th className="px-4 py-3">Lead</th>
                  <th className="px-4 py-3">Recipient</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3 whitespace-nowrap">Type</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-4 py-3 whitespace-nowrap">Created</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-midnight-line/40">
                {drafts.map((draft) => {
                  const isOpeningGmail = openingGmailId === draft.message.id;
                  const isDeleting = deletingId === draft.message.id;

                  return (
                    <tr key={draft.message.id} className="hover:bg-midnight-faint/50">
                      <td className="px-4 py-3 font-semibold text-midnight-ink">{draftTitle(draft)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-midnight-soft">{draft.message.recipient_email}</td>
                      <td className="px-4 py-3 truncate text-midnight-ink">{draft.message.subject || "(No subject)"}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs font-semibold text-midnight-soft">{sequenceLabel(draft.message.sequence_number)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center rounded-full border-2 px-2 py-0.5 text-[11px] uppercase tracking-wider ${
                          draft.message.status === "draft"
                            ? "bg-midnight-faint text-midnight border-midnight"
                            : draft.message.status === "ready"
                            ? "bg-emerald-faint text-emerald border-emerald"
                            : "bg-amber-faint text-amber border-amber"
                        }`}>
                          {draft.message.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-midnight-soft">{formatDate(draft.message.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            href={`/drafts/${draft.message.id}`}
                            className="btn btn-xs"
                          >
                            View
                          </Link>
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() => handleOpenInGmail(draft.message.id, draft)}
                            disabled={isOpeningGmail || isDeleting}
                          >
                            {isOpeningGmail ? "…" : "Gmail"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-xs text-red"
                            onClick={() => handleDelete(draft.message.id)}
                            disabled={isDeleting || isOpeningGmail}
                          >
                            {isDeleting ? "…" : "Del"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.kind === "error" ? "notice-alarm" : "notice-info"}`} role="alert">
          {notice.text}
        </div>
      )}
    </div>
  );
}