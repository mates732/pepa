"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { deleteOutreachMessage, loadFollowUpDetail, recordOutreachSent } from "@/app/actions";
import { createFollowUp } from "@/app/followup-actions";
import { FollowUpDetail } from "@/components/follow-up-detail";
import { openGmailComposeSmart } from "@/lib/outreach/open-gmail-compose";
import type { FollowUpDetail as FollowUpDetailData } from "@/lib/services/follow-up-sequence-service";

interface PanelNotice {
  kind: "info" | "error";
  text: string;
}

/**
 * The Phase 4C follow-up detail, mounted where the Telegram notification
 * lands (dashboard `?followup=<token>`).
 *
 * Responsibilities kept deliberately narrow:
 *
 *   * load the detail server-side-by-action from the message id the page
 *     resolved from the token — the panel itself never invents an id;
 *   * wire the view's callbacks to the existing session-gated actions;
 *   * keep the mark-as-sent confirmation explicit: a quality-gate warning
 *     arms one second click, a blocked send writes nothing;
 *   * record nothing when the panel merely opens. Gmail opening only ever
 *     prefills compose — the send state changes solely through
 *     `recordOutreachSent`, the same compare-and-set action the workspace uses.
 */
export function FollowUpDetailPanel({ messageId }: { messageId: string }) {
  const [detail, setDetail] = useState<FollowUpDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState<PanelNotice | null>(null);

  const [openingGmail, setOpeningGmail] = useState(false);
  const [recording, setRecording] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [armed, setArmed] = useState(false);
  const loadedRef = useRef(false);

  const reload = useCallback(async () => {
    const result = await loadFollowUpDetail(messageId);
    if (result.ok) {
      setDetail(result.detail);
      setError(null);
    } else {
      setError(result.error);
    }
  }, [messageId]);

  useEffect(() => {
    // One initial fetch per message id; later loads are explicit action calls
    // from the handlers below (same guarded pattern as FollowUpsClient).
    if (!loadedRef.current) {
      loadedRef.current = true;
      void reload();
    }
  }, [reload]);

  if (!open) return null;

  if (error) {
    return (
      <div className="notice notice-alarm" role="alert">
        {error}
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="sticker p-6">
        <p className="text-sm text-midnight-soft">Loading follow-up…</p>
      </div>
    );
  }

  async function handleOpenInGmail(id: string) {
    // The panel opens the message it was given — never a neighbour in the
    // same sequence. Filling compose records nothing anywhere.
    if (id !== detail!.message.id) return;
    setOpeningGmail(true);
    try {
      openGmailComposeSmart({
        to: detail!.message.recipient_email,
        subject: detail!.message.subject,
        body: detail!.message.body,
      });
    } finally {
      // Navigation happens synchronously in the helper; state resets if it did not.
      setOpeningGmail(false);
    }
  }

  async function handleMarkSent(id: string, leadId: string) {
    if (recording || id !== detail!.message.id) return;
    setRecording(true);
    setNotice(null);
    try {
      const result = await recordOutreachSent({
        messageId: id,
        leadId,
        confirmWarnings: armed,
      });

      if (result.ok) {
        setArmed(false);
        setNotice({
          kind: "info",
          text:
            result.outcome === "already_sent"
              ? "Already recorded as sent — nothing was changed."
              : `Recorded as sent${result.nextFollowUpAt ? " — the next follow-up is scheduled." : "."}`,
        });
        await reload();
        return;
      }

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        setArmed(true);
        setNotice({
          kind: "info",
          text: `${result.error ?? "The quality gate reported warnings."} Read them, then confirm with “Confirm sent”.`,
        });
        return;
      }

      setArmed(false);
      setNotice({ kind: "error", text: result.error });
    } catch {
      setArmed(false);
      setNotice({ kind: "error", text: "The send could not be recorded. Try again." });
    } finally {
      setRecording(false);
    }
  }

  async function handleCreateFollowUp(parentMessageId: string, subject: string, body: string) {
    if (creating) return;
    setCreating(true);
    setNotice(null);
    try {
      const result = await createFollowUp({ parentMessageId, subject, body });
      if (result.ok) {
        setNotice({
          kind: "info",
          text: `Follow-up #${result.sequenceNumber} saved. Nothing was sent and nobody was notified.`,
        });
        await reload();
      } else {
        setNotice({ kind: "error", text: result.error });
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (deleting) return;
    setDeleting(true);
    setNotice(null);
    try {
      const result = await deleteOutreachMessage({ messageId: id });
      if (result.ok) {
        // The row is gone; the panel closes rather than showing a ghost.
        setOpen(false);
      } else {
        setNotice({ kind: "error", text: result.error });
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <FollowUpDetail
      detail={detail}
      onClose={() => setOpen(false)}
      onOpenInGmail={(id) => void handleOpenInGmail(id)}
      onMarkSent={(id, leadId) => void handleMarkSent(id, leadId)}
      onCreateFollowUp={(parentId, subject, body) => void handleCreateFollowUp(parentId, subject, body)}
      onDelete={(id) => void handleDelete(id)}
      openingGmail={openingGmail}
      recording={recording}
      creating={creating}
      deleting={deleting}
      notice={notice}
    />
  );
}
