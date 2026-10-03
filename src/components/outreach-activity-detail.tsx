"use client";

import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import type { OutreachActivityDetail } from "@/lib/services/outreach-activity-service";

/**
 * Outreach Activity — the detail.
 *
 * Shows the exact outreach that was recorded as sent: recipient, subject and
 * body exactly as stored, plus where that message sits in its sequence.
 *
 * Two absences are stated, never filled:
 *
 *   * a missing predecessor means the row was deleted (Phase 4A uses
 *     `ON DELETE SET NULL`), which renders as "Predecessor removed";
 *   * a missing sequence head means the initial outreach was never stored, which
 *     renders as "Not recorded".
 *
 * The sequence is read from real rows only. Nothing here is inferred from the
 * subject, the body or `leads.followup_count`.
 *
 * There is no edit, no delete and no "mark unsent": Activity is an audit
 * surface, and a recorded send is immutable from here. The single control is the
 * read-only Gmail hand-off, which fills a compose window and writes nothing.
 */

interface OutreachActivityDetailProps {
  detail: OutreachActivityDetail;
  onClose: () => void;
  onOpenInGmail: (messageId: string) => void;
  openingGmail: boolean;
  notice: { kind: "info" | "error"; text: string } | null;
}

/** One node of the rendered chain. */
interface ChainNode {
  key: string;
  label: string;
  detail: string | null;
  state: "current" | "past" | "missing";
}

/**
 * Head → predecessor → this message, however long the real chain is.
 *
 * A follow-up whose own predecessor is missing still renders its head and its
 * current slot, with the gap named between them.
 */
function chainFor(detail: OutreachActivityDetail): ChainNode[] {
  const { message } = detail;
  const nodes: ChainNode[] = [];

  const sentLine = (row: { sent_at: string | null; created_at: string }) =>
    row.sent_at ? `Sent ${formatDate(row.sent_at)}` : formatDate(row.created_at);

  if (detail.initial) {
    nodes.push({
      key: detail.initial.id,
      label: "Initial outreach",
      detail: sentLine(detail.initial),
      state: detail.initial.id === message.id ? "current" : "past",
    });
  } else if (!detail.isInitial) {
    // No slot-0 row exists. Honest wording; no invented ancestor.
    nodes.push({ key: "initial-missing", label: "Initial outreach", detail: "Not recorded", state: "missing" });
  }

  if (!detail.isInitial) {
    if (detail.parent) {
      nodes.push({
        key: detail.parent.id,
        label: `Follow-up #${detail.parent.sequence_number}`,
        detail: sentLine(detail.parent),
        state: "past",
      });
    } else {
      // The predecessor row is gone, not merely unread.
      nodes.push({ key: "parent-missing", label: "Predecessor", detail: "Predecessor removed", state: "missing" });
    }

    nodes.push({
      key: message.id,
      label: `Follow-up #${message.sequence_number}`,
      detail: sentLine(message),
      state: "current",
    });
  }

  return nodes;
}

export function OutreachActivityDetail({
  detail,
  onClose,
  onOpenInGmail,
  openingGmail,
  notice,
}: OutreachActivityDetailProps) {
  const { lead, message } = detail;
  const leadLabel = lead.company_name || lead.contact_name || lead.email;

  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">{detail.typeLabel}</h2>
        <button type="button" onClick={onClose} className="btn btn-sm">
          Close
        </button>
      </header>

      <div className="space-y-5 p-4">
        {/* --- Lead ---------------------------------------------------- */}
        <div>
          <h3 className="field-label">Lead</h3>
          <p className="break-words font-bold text-midnight">{leadLabel}</p>
          {lead.company_name && lead.contact_name ? (
            <p className="break-words text-xs text-midnight-soft">{lead.contact_name}</p>
          ) : null}
          <p className="break-all font-mono text-xs text-midnight-soft">{lead.email}</p>
        </div>

        {/* --- When, to whom, what kind -------------------------------- */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="min-w-0">
            <h3 className="field-label">Recipient</h3>
            <p className="break-all font-mono text-xs text-midnight">{message.recipient_email}</p>
          </div>
          <div className="min-w-0">
            <h3 className="field-label">Sent</h3>
            <p className="text-sm font-bold text-midnight">
              {formatTime(message.sent_at)}
              {message.sent_at ? (
                <span className="block text-xs font-normal text-midnight-soft">
                  {formatDateTime(message.sent_at)}
                </span>
              ) : (
                <span className="block text-xs font-normal text-midnight-soft">Not recorded</span>
              )}
            </p>
          </div>
          <div className="min-w-0">
            <h3 className="field-label">Type</h3>
            <p className="text-sm font-bold text-midnight">{detail.typeLabel}</p>
          </div>
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
        </div>

        {/* --- The message, verbatim ----------------------------------- */}
        <div className="min-w-0 space-y-3">
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
            One read-only control. Activity has no mutation surface at all,
            so there is nothing here to mark unsent, edit or delete. */}
        <div className="flex flex-wrap items-center gap-2 border-t-[3px] border-dashed border-midnight-line pt-4">
          <button
            type="button"
            onClick={() => onOpenInGmail(message.id)}
            disabled={openingGmail}
            className="btn"
            title="Opens a Gmail draft with this exact text. It does not send anything and changes nothing in PEPA."
          >
            {openingGmail ? "Opening…" : "Open in Gmail ↗"}
          </button>

          <p className="w-full pt-1 text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
            This outreach is recorded as sent. Activity cannot change it — opening Gmail writes nothing.
          </p>
        </div>
      </div>
    </section>
  );
}