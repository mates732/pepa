"use client";

import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { formatDate, formatDateTime } from "@/lib/format";
import type { FollowUpDetail } from "@/lib/services/follow-up-sequence-service";

/**
 * Follow-up detail.
 *
 * The point of this view is that the operator never has to remember what the
 * original outreach was. It renders the sequence chain from stored rows only:
 * `initial` is the sequence head (slot 0), `parent` is the direct predecessor,
 * and the current message is highlighted.
 *
 * Two absences are handled explicitly rather than papered over:
 *
 *   * `parent === null` on a follow-up means the predecessor row was deleted
 *     (Phase 4A uses ON DELETE SET NULL). It renders as "Predecessor removed".
 *     The chain is not reconstructed, because the message no longer exists.
 *
 *   * `unrecordedHistory` means the lead's counter claims follow-ups that were
 *     never stored. That is stated plainly instead of being turned into a row.
 */

interface FollowUpDetailProps {
  detail: FollowUpDetail;
  onClose: () => void;
  onOpenInGmail: (messageId: string) => void;
  onMarkSent: (messageId: string, leadId: string) => void;
  onCreateFollowUp: (parentMessageId: string, subject: string, body: string) => void;
  onDelete: (messageId: string) => void;
  openingGmail: boolean;
  recording: boolean;
  creating: boolean;
  deleting: boolean;
  notice: { kind: "info" | "error"; text: string } | null;
}

/** One node of the rendered chain. */
interface ChainNode {
  key: string;
  label: string;
  detail: string | null;
  state: "current" | "past" | "missing";
}

function chainFor(detail: FollowUpDetail): ChainNode[] {
  const nodes: ChainNode[] = [];

  if (detail.initial) {
    nodes.push({
      key: detail.initial.id,
      label: "Initial outreach",
      detail: detail.initial.sent_at
        ? `Sent ${formatDate(detail.initial.sent_at)}`
        : detail.initial.status === "sent"
          ? "Sent"
          : formatDate(detail.initial.created_at),
      state: detail.initial.id === detail.message.id ? "current" : "past",
    });
  } else if (!detail.isInitial) {
    // No slot-0 row. Honest wording; no invented ancestor.
    nodes.push({
      key: "initial-missing",
      label: "Initial outreach",
      detail: "Not recorded",
      state: "missing",
    });
  }

  if (!detail.isInitial) {
    // Predecessor and current message are one block: for a follow-up the chain
    // is always "head → predecessor → this", however long the real chain is.
    if (detail.parent) {
      nodes.push({
        key: detail.parent.id,
        label: `Follow-up #${detail.parent.sequence_number}`,
        detail: detail.parent.sent_at
          ? `Sent ${formatDate(detail.parent.sent_at)}`
          : detail.parent.status === "sent"
            ? "Sent"
            : formatDate(detail.parent.created_at),
        state: detail.parent.id === detail.message.id ? "current" : "past",
      });
    } else {
      // ON DELETE SET NULL: the predecessor row is gone, not merely unread.
      nodes.push({
        key: "parent-missing",
        label: "Predecessor",
        detail: "Predecessor removed",
        state: "missing",
      });
    }
  }

  if (!detail.isInitial) {
    nodes.push({
      key: detail.message.id,
      label: `Follow-up #${detail.message.sequence_number}`,
      detail: detail.message.sent_at
        ? `Sent ${formatDate(detail.message.sent_at)}`
        : "Current",
      state: "current",
    });
  }

  return nodes;
}

export function FollowUpDetail({
  detail,
  onClose,
  onOpenInGmail,
  onMarkSent,
  onCreateFollowUp,
  onDelete,
  openingGmail,
  recording,
  creating,
  deleting,
  notice,
}: FollowUpDetailProps) {
  const { lead, message } = detail;
  const sent = message.sent_at !== null || message.status === "sent";
  const leadLabel = lead.company_name || lead.contact_name || lead.email;

  // Phase 8F — the next follow-up in this sequence, drafted in place.
  const [followUpSubject, setFollowUpSubject] = useState("");
  const [followUpBody, setFollowUpBody] = useState("");

  // Delete confirmation state
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          {detail.isInitial ? "Initial outreach" : `Follow-up #${message.sequence_number}`}
        </h2>
        <button type="button" onClick={onClose} className="btn btn-sm">
          Close
        </button>
      </header>

      <div className="space-y-5 p-4">
        {/* --- Lead --------------------------------------------------- */}
        <div>
          <h3 className="field-label">Lead</h3>
          <p className="break-words font-bold text-midnight">{leadLabel}</p>
          {lead.company_name && lead.contact_name ? (
            <p className="break-words text-xs text-midnight-soft">{lead.contact_name}</p>
          ) : null}
          <p className="break-all font-mono text-xs text-midnight-soft">{lead.email}</p>
        </div>

        {/* --- Sequence ------------------------------------------------ */}
        <div>
          <h3 className="field-label">Sequence</h3>
          <ol className="space-y-1.5">
            {chainFor(detail).map((node, index) => (
              <li key={node.key} className="min-w-0">
                {index > 0 ? (
                  <span aria-hidden className="block pl-3 text-midnight-line">
                    ↓
                  </span>
                ) : null}
                <div
                  className={`min-w-0 rounded-[0.9rem] border-2 px-3 py-2 ${
                    node.state === "current"
                      ? "border-midnight bg-midnight-faint/60"
                      : node.state === "missing"
                        ? "border-dashed border-midnight-line bg-paper"
                        : "border-midnight-line bg-paper"
                  }`}
                >
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-midnight">
                    <span className="break-words">{node.label}</span>
                    {node.state === "current" ? <span className="chip">current</span> : null}
                  </p>
                  <p className="break-words text-xs text-midnight-soft">{node.detail}</p>
                </div>
              </li>
            ))}
          </ol>

          {detail.unrecordedHistory ? (
            <p className="mt-2 text-xs font-semibold text-midnight-soft">
              This lead&apos;s counter records more follow-ups than are stored. Historical
              follow-up not recorded — nothing is shown here because it does not exist.
            </p>
          ) : null}
        </div>

        {/* --- State --------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="field-label">Status</h3>
          <StatusBadge status={message.status} />
          {message.sent_at ? (
            <span className="text-xs text-midnight-soft">Sent {formatDateTime(message.sent_at)}</span>
          ) : null}
        </div>

        {/* --- Message ------------------------------------------------- */}
        <div className="min-w-0 space-y-3">
          <div>
            <h3 className="field-label">Recipient</h3>
            <p className="break-all font-mono text-xs text-midnight-soft">
              {message.recipient_email}
            </p>
          </div>
          <div className="min-w-0">
            <h3 className="field-label">Subject</h3>
            <p className="break-words font-bold text-midnight">{message.subject || "—"}</p>
          </div>
          <div className="min-w-0">
            <h3 className="field-label">Body</h3>
            {/* `break-words` + `whitespace-pre-wrap` so a long address or an
                unbroken line cannot push the layout wide on mobile. */}
            <p className="max-w-full whitespace-pre-wrap break-words text-sm leading-relaxed text-midnight">
              {message.body || "—"}
            </p>
          </div>
        </div>

        {notice ? (
          <p className={notice.kind === "error" ? "notice notice-alarm" : "notice"}>{notice.text}</p>
        ) : null}

        {/* --- Actions -------------------------------------------------
            Two distinct controls, because they mean different things.
            "Open in Gmail" fills a compose window and records nothing.
            Only "Mark as sent" writes, and it goes through the existing
            authenticated action, so the server-authoritative gate still runs. */}
        <div className="flex flex-wrap items-center gap-2 border-t-[3px] border-dashed border-midnight-line pt-4">
          <button
            type="button"
            onClick={() => onOpenInGmail(message.id)}
            disabled={openingGmail || deleting}
            className="btn"
            title="Opens a Gmail draft with this text. This does not send anything and does not mark it as sent."
          >
            {openingGmail ? "Opening…" : "Open in Gmail ↗"}
          </button>

          <button
            type="button"
            onClick={() => onMarkSent(message.id, lead.id)}
            disabled={recording || sent || deleting}
            className="btn btn-primary"
            title="Record this follow-up as sent. Runs the quality gate first."
          >
            {sent ? "Already sent" : recording ? "Recording…" : "Mark as sent"}
          </button>

          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              className="btn btn-ghost"
              title="Delete this outreach message permanently. This cannot be undone."
            >
              {deleting ? "Deleting…" : "Smazat"}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-midnight-soft">
                Opravdu smazat? Tato akce je nevratná.
              </span>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="btn btn-sm"
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete(message.id);
                }}
                disabled={deleting}
                className="btn btn-sm btn-alarm"
              >
                {deleting ? "Deleting…" : "Smazat"}
              </button>
            </div>
          )}

          <p className="w-full pt-1 text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
            Opening Gmail does not mark this as sent.
          </p>
        </div>

        {/* --- Next follow-up ---------------------------------------------
            Phase 8F. Drafting a follow-up used to be impossible from here:
            the composer token was only ever minted as a side effect of the
            scheduler notifying the operator on Telegram, so writing a
            follow-up required sending a notification first. This form calls
            the session-gated action directly.

            It saves the next sequence row and notifies nobody. The anchor is
            the message on screen, and the server refuses if a later follow-up
            already exists for this recipient — re-saving or branching is not
            something the client can talk its way into. */}
        <form
          className="space-y-2 border-t-[3px] border-dashed border-midnight-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!followUpSubject.trim() || creating) return;
            onCreateFollowUp(message.id, followUpSubject, followUpBody);
            setFollowUpSubject("");
            setFollowUpBody("");
          }}
        >
          <h3 className="field-label">Next follow-up</h3>
          <input
            type="text"
            value={followUpSubject}
            onChange={(event) => setFollowUpSubject(event.target.value)}
            maxLength={998}
            placeholder={message.subject ? `Re: ${message.subject}` : "Subject"}
            aria-label="Follow-up subject"
            className="field"
          />
          <textarea
            value={followUpBody}
            onChange={(event) => setFollowUpBody(event.target.value)}
            rows={4}
            placeholder="Body"
            aria-label="Follow-up body"
            className="field"
          />
          <button
            type="submit"
            disabled={creating || !followUpSubject.trim()}
            className="btn btn-primary"
            title="Save the next follow-up in this sequence. Nothing is sent and nobody is notified."
          >
            {creating
              ? "Saving…"
              : `Save follow-up #${message.sequence_number + 1}`}
          </button>
          <p className="w-full pt-1 text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
            Saving a follow-up sends nothing and notifies nobody.
          </p>
        </form>
      </div>
    </section>
  );
}
