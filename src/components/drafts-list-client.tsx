"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

import { openGmailComposeSmart } from "@/lib/outreach/open-gmail-compose";
import {
  deleteOutreachMessage,
  loadOutreachDraftRows,
  recordOutreachSent,
} from "@/app/actions";
import type { OutreachDraftRow } from "@/lib/services/outreach-service";
import { formatDate, sequenceLabel, draftTitle } from "@/lib/utils/date";

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
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
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

    // Centralized helper: on iOS the native Gmail app opens into a prefilled
    // compose screen (iPhone-verified deep link), elsewhere web compose. The
    // full stored draft goes across; nothing is sent, nothing is marked sent.
    openGmailComposeSmart({
      to: draft.message.recipient_email,
      subject: draft.message.subject,
      body: draft.message.body,
    });

    // Navigation happens synchronously in the helper via window.location.assign().
    // No notice needed — the browser (or the Gmail app) takes over.
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

  /**
   * The explicit, and only, way an initial email leaves the outbox in PEPA.
   *
   * PEPA sends no mail itself: the operator sends the draft from their own
   * client (the Gmail button above opens it prefilled) and then records the
   * fact here, so the follow-up engine can schedule from a real send. The
   * server action compare-and-sets, so a double submit is safe — the second
   * call reports `already_sent` and schedules nothing. The quality gate runs
   * server-side at the moment of the write; on warnings the button arms for
   * one explicit second click, and a blocked send never writes.
   */
  async function handleMarkSent(draft: OutreachDraftRow) {
    if (recordingId) return;
    setRecordingId(draft.message.id);
    setNotice(null);
    try {
      const result = await recordOutreachSent({
        messageId: draft.message.id,
        leadId: draft.lead.id,
        confirmWarnings: armedId === draft.message.id,
      });

      if (result.ok) {
        setArmedId(null);
        setNotice({
          kind: "info",
          text:
            result.outcome === "already_sent"
              ? "Already recorded as sent — nothing was changed."
              : `Recorded as sent${result.nextFollowUpAt ? " — the next follow-up is scheduled." : "."}`,
        });
        // The row leaves the Drafts list: the list only ever contains unsent
        // messages, so keeping it would show a draft that is already sent.
        setDrafts((current) =>
          current.filter((d) => d.message.id !== draft.message.id),
        );
        return;
      }

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        // Warnings, not a refusal: arm one explicit confirmation click.
        setArmedId(draft.message.id);
        setNotice({
          kind: "info",
          text: `${result.error ?? "The quality gate reported warnings."} Read them, then confirm with “Confirm sent”.`,
        });
        return;
      }

      setArmedId(null);
      setNotice({ kind: "error", text: result.error });
    } catch {
      setArmedId(null);
      setNotice({ kind: "error", text: "The send could not be recorded. Try again." });
    } finally {
      setRecordingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="heading-sticker text-xl text-midnight">Drafts</h1>
        <p className="mt-1 text-sm text-midnight-soft">
          {drafts.length} draft{drafts.length === 1 ? "" : "s"} saved · initial outreach only
        </p>
        <p className="mt-1 text-xs text-midnight-soft">
          Each draft is an <strong>initial outreach</strong> (sequence 0).
          Send it from your own mail client with “Gmail”, then record the fact
          here with “Mark as sent” — opening Gmail never marks anything as sent.
          Follow-ups are created from the initial email and appear in{" "}
          <Link href="/follow-ups" className="font-semibold text-accent underline-offset-2 hover:underline">
            Follow-ups
          </Link>{" "}
          only when due.
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
                <tr className="border-b border-midnight-line text-left text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
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
                  const isRecording = recordingId === draft.message.id;
                  const isArmed = armedId === draft.message.id;

                  return (
                    <tr key={draft.message.id} className="hover:bg-midnight-faint/50">
                      <td className="px-4 py-3 font-semibold text-midnight">{draftTitle(draft)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-midnight-soft">{draft.message.recipient_email}</td>
                      <td className="px-4 py-3 truncate text-midnight">{draft.message.subject || "(No subject)"}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs font-semibold text-midnight-soft">{sequenceLabel(draft.message.sequence_number)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wider ${
                          draft.message.status === "draft"
                            ? "bg-midnight-faint text-midnight-soft border-midnight-line-strong"
                            : draft.message.status === "ready"
                            ? "bg-success-soft text-success-ink border-success-line"
                            : "bg-warning-soft text-warning-ink border-warning-line"
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
                            disabled={isOpeningGmail || isDeleting || isRecording}
                          >
                            {isOpeningGmail ? "…" : "Gmail"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-xs btn-primary"
                            onClick={() => handleMarkSent(draft)}
                            disabled={isRecording || recordingId !== null}
                            title="Record that you already sent this email from your own mail client. Runs the quality gate first; opening Gmail never marks anything as sent."
                          >
                            {isRecording ? "…" : isArmed ? "Confirm sent" : "Mark as sent"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-xs text-red"
                            onClick={() => handleDelete(draft.message.id)}
                            disabled={isDeleting || isOpeningGmail || isRecording}
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