"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

import { openGmailComposeSmart } from "@/lib/outreach/open-gmail-compose";
import { loadFollowUps, recordOutreachSent } from "@/app/actions";
import { formatDate, formatDateTime, sequenceLabel, leadTitle } from "@/lib/utils/date";
import {
  followUpScheduleState,
  groupFollowUps,
  scheduleStateLabel,
  type FollowUpBucket,
} from "@/lib/utils/follow-ups";

interface Notice {
  kind: "info" | "error";
  text: string;
}

/**
 * The workspace slice of `FollowUpListItem` as it reaches the browser. The
 * fields the spec requires on every row are all here: lead, recipient,
 * sequence position, original send date, due date and status.
 */
interface FollowUpItem {
  message: {
    id: string;
    recipient_email: string;
    subject: string | null;
    body: string | null;
    status: string;
    sequence_number: number;
    created_at: string;
    sent_at: string | null;
    parent_message_id: string | null;
  };
  lead: {
    id: string;
    email: string;
    company_name: string | null;
    contact_name: string | null;
  };
  due: boolean;
  dueAt: string | null;
  initialSentAt: string | null;
  initialSent: boolean;
  attention: 0 | 1 | 2;
}

interface Props {
  initialFollowUps: FollowUpItem[];
  initialError: string | null;
}

const SECTION_INTRO: Record<FollowUpBucket, string> = {
  due: "Ready to send manually in Gmail. Opening Gmail never marks anything as sent — only “Mark as sent” does, and only after you confirm.",
  scheduled: "Future follow-ups stay here, out of the ready-to-send queue, until their due time arrives after the initial email was sent.",
  sent: "Follow-ups already recorded as sent. Opening Gmail from history is never offered here.",
};

export function FollowUpsClient({ initialFollowUps, initialError }: Props) {
  const [followUps, setFollowUps] = useState<FollowUpItem[]>(initialFollowUps);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [openingGmailId, setOpeningGmailId] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const loadedRef = useRef(false);

  const loadFollowUpsData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadFollowUps();
      if (result.ok) {
        setFollowUps(result.followUps);
      } else {
        setError(result.error);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loadedRef.current && initialFollowUps.length === 0 && !initialError) {
      loadedRef.current = true;
      loadFollowUpsData();
    }
  }, [initialFollowUps, initialError, loadFollowUpsData]);

  function handleOpenInGmail(item: FollowUpItem) {
    setOpeningGmailId(item.message.id);
    setNotice(null);

    // The row's own recipient — never the lead's primary address, and never a
    // different message from the same sequence. On iOS the native Gmail app
    // opens into a prefilled compose screen (iPhone-verified deep link),
    // elsewhere web compose. Nothing is sent, nothing is marked sent.
    openGmailComposeSmart({
      to: item.message.recipient_email,
      subject: item.message.subject,
      body: item.message.body,
    });

    // Navigation happens synchronously in the helper via window.location.assign().
  }

  /**
   * The explicit, and only, send-recording action in this workspace.
   *
   * The server action compare-and-sets, so a double submit is safe: the second
   * call reports `already_sent` and schedules nothing. The quality gate may ask
   * for confirmation first — the warnings are surfaced and the button arms for
   * one explicit second click; a blocked send never writes.
   */
  async function handleMarkSent(item: FollowUpItem) {
    if (recordingId) return;
    setRecordingId(item.message.id);
    setNotice(null);
    try {
      const result = await recordOutreachSent({
        messageId: item.message.id,
        leadId: item.lead.id,
        confirmWarnings: armedId === item.message.id,
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
        await loadFollowUpsData();
        return;
      }

      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        // Warnings, not a refusal: arm one explicit confirmation click.
        setArmedId(item.message.id);
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

  const grouped = groupFollowUps(followUps);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="heading-sticker text-xl text-midnight">Follow-ups</h1>
        <p className="mt-1 text-sm text-midnight-soft">
          {grouped.due.length} due · {grouped.scheduled.length} scheduled ·{" "}
          {grouped.sent.length} sent
        </p>
      </header>

      {error && (
        <div className="notice notice-alarm" role="alert">{error}</div>
      )}

      {loading ? (
        <div className="sticker p-8 text-center">
          <p className="text-midnight-soft">Loading follow-ups…</p>
        </div>
      ) : followUps.length === 0 ? (
        <div className="sticker p-8 text-center">
          <p className="text-midnight-soft mb-4">No follow-ups yet.</p>
          <a href="/parser" className="btn btn-primary">Paste Emails</a>
        </div>
      ) : (
        <>
          <Section
            bucket="due"
            items={grouped.due}
            openingGmailId={openingGmailId}
            recordingId={recordingId}
            armedId={armedId}
            onOpenInGmail={handleOpenInGmail}
            onMarkSent={handleMarkSent}
          />
          <Section
            bucket="scheduled"
            items={grouped.scheduled}
            openingGmailId={openingGmailId}
            recordingId={recordingId}
            armedId={armedId}
            onOpenInGmail={handleOpenInGmail}
            onMarkSent={handleMarkSent}
          />
          <Section
            bucket="sent"
            items={grouped.sent}
            openingGmailId={openingGmailId}
            recordingId={recordingId}
            armedId={armedId}
            onOpenInGmail={handleOpenInGmail}
            onMarkSent={handleMarkSent}
          />
        </>
      )}

      {notice && (
        <div className={`notice ${notice.kind === "error" ? "notice-alarm" : "notice-info"}`} role="alert">
          {notice.text}
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  bucket: FollowUpBucket;
  items: FollowUpItem[];
  openingGmailId: string | null;
  recordingId: string | null;
  armedId: string | null;
  onOpenInGmail: (item: FollowUpItem) => void;
  onMarkSent: (item: FollowUpItem) => void;
}

/**
 * One workspace section. Only the `due` section ever offers Gmail or
 * mark-as-sent: scheduled follow-ups are not actionable, and sent rows are
 * history — so an initial email and its follow-up can never sit side by side
 * as two indistinguishable drafts, and no future follow-up can leak into the
 * ready-to-send queue.
 */
function Section({ bucket, items, openingGmailId, recordingId, armedId, onOpenInGmail, onMarkSent }: SectionProps) {
  const titles: Record<FollowUpBucket, string> = {
    due: "Due now",
    scheduled: "Scheduled",
    sent: "Sent",
  };

  if (items.length === 0) {
    // The due section is never silently absent: "nothing to do" is an answer.
    if (bucket !== "due") return null;
    return (
      <section aria-labelledby={`followups-${bucket}-heading`} className="sticker px-4 py-3">
        <h2 id={`followups-${bucket}-heading`} className="text-sm font-bold text-midnight">
          {titles[bucket]} (0)
        </h2>
        <p className="mt-1 text-sm text-midnight-soft">Nothing is due right now.</p>
      </section>
    );
  }

  const timeHeader = bucket === "sent" ? "Follow-up sent" : "Due";

  return (
    <section aria-labelledby={`followups-${bucket}-heading`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`followups-${bucket}-heading`} className="heading-sticker text-sm text-midnight-soft">
          {titles[bucket]} ({items.length})
        </h2>
        <p className="max-w-xl text-xs text-midnight-soft">{SECTION_INTRO[bucket]}</p>
      </div>

      <div className="sticker overflow-x-auto">
        {/* Deliberate mobile strategy (same as Drafts/Outreach): scroll
            horizontally instead of crushing seven columns. */}
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-midnight-line text-left text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
              <th className="px-4 py-3">Lead</th>
              <th className="px-4 py-3">Recipient</th>
              <th className="px-4 py-3 whitespace-nowrap">Sequence</th>
              <th className="px-4 py-3 whitespace-nowrap">Initial sent</th>
              <th className="px-4 py-3 whitespace-nowrap">{timeHeader}</th>
              <th className="px-4 py-3 whitespace-nowrap">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-midnight-line/40">
            {items.map((item) => {
              const state = followUpScheduleState(item);
              const isRecording = recordingId === item.message.id;
              const isArmed = armedId === item.message.id;
              const isOpening = openingGmailId === item.message.id;

              return (
                <tr key={item.message.id} className="hover:bg-midnight-faint/50">
                  <td className="px-4 py-3 font-semibold text-midnight">{leadTitle(item.lead)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-midnight-soft">
                    {item.message.recipient_email}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs font-semibold text-midnight-soft">
                    {sequenceLabel(item.message.sequence_number)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-midnight-soft">
                    {item.initialSentAt ? formatDate(item.initialSentAt) : "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-midnight-soft">
                    {bucket === "sent"
                      ? formatDateTime(item.message.sent_at)
                      : item.dueAt
                        ? formatDateTime(item.dueAt)
                        : "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span
                      className={
                        bucket === "due"
                          ? "chip chip-danger"
                          : bucket === "sent"
                            ? "chip chip-success"
                            : state === "scheduled"
                              ? "chip chip-warning"
                              : "chip"
                      }
                    >
                      {bucket === "sent" ? "Sent" : scheduleStateLabel(state)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {bucket === "due" && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => onOpenInGmail(item)}
                            disabled={isOpening || isRecording}
                            title="Opens a Gmail draft with this follow-up. Nothing is sent and nothing is marked as sent."
                          >
                            {isOpening ? "Opening…" : "Gmail"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => onMarkSent(item)}
                            disabled={isRecording || recordingId !== null}
                            title="Record this follow-up as sent. Runs the quality gate first."
                          >
                            {isRecording
                              ? "Recording…"
                              : isArmed
                                ? "Confirm sent"
                                : "Mark as sent"}
                          </button>
                        </>
                      )}
                      <Link href={`/drafts/${item.message.id}`} className="btn btn-sm">
                        View
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
