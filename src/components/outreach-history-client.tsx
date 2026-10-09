"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

import { openGmailCompose } from "@/lib/outreach/open-gmail-compose";
import { loadOutreachHistory } from "@/app/actions";
import { formatDate, formatDateTime, sequenceLabel, leadTitle } from "@/lib/utils/date";

interface Notice {
  kind: "info" | "error";
  text: string;
}

interface HistoryLead {
  id: string;
  email: string;
  company_name: string | null;
  contact_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  next_followup_at: string | null;
  followup_count: number;
  latestSubject: string | null;
  latestMessageStatus: string | null;
  latestMessageAt: string | null;
  messageCount: number;
  lastFollowupNotifiedNumber: number | null;
  lastFollowupNotifiedAt: string | null;
  unsent: boolean;
  mainEmail?: { message: { id: string; subject: string | null; status: string; sequence_number: number; created_at: string; sent_at: string | null }; kind: string } | null;
  followUpEmail?: { message: { id: string; subject: string | null; status: string; sequence_number: number; created_at: string; sent_at: string | null }; kind: string } | null;
}

interface Props {
  initialHistory: HistoryLead[];
  initialError: string | null;
}

export function OutreachHistoryClient({ initialHistory, initialError }: Props) {
  const [history, setHistory] = useState<HistoryLead[]>(initialHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [openingGmailId, setOpeningGmailId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const loadedRef = useRef(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadOutreachHistory();
      if (result.ok) {
        setHistory(result.leads);
      } else {
        setError(result.error);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loadedRef.current && initialHistory.length === 0 && !initialError) {
      loadedRef.current = true;
      loadHistory();
    }
  }, [initialHistory, initialError, loadHistory]);

  async function handleOpenInGmail(messageId: string, recipient: string, subject: string | null, body: string | null) {
    setOpeningGmailId(messageId);
    setNotice(null);

    const result = openGmailCompose({
      to: recipient,
      subject,
      body,
    });

    setNotice({
      kind: result.opened ? "info" : "error",
      text: result.message,
    });

    setOpeningGmailId(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="heading-sticker text-2xl text-midnight">Outreach History</h1>
        <p className="mt-1 text-sm text-midnight-soft">
          {history.length} lead{history.length === 1 ? "" : "s"} with outreach history
        </p>
      </header>

      {error && (
        <div className="notice notice-alarm" role="alert">{error}</div>
      )}

      {loading ? (
        <div className="sticker p-8 text-center">
          <p className="text-midnight-soft">Loading history…</p>
        </div>
      ) : history.length === 0 ? (
        <div className="sticker p-8 text-center">
          <p className="text-midnight-soft mb-4">No outreach history yet.</p>
          <a href="/parser" className="btn btn-primary">Paste Emails</a>
        </div>
      ) : (
        <section className="sticker overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-[3px] border-midnight text-left text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3 max-w-[300px]">Latest Subject</th>
                <th className="px-4 py-3 whitespace-nowrap">Status</th>
                <th className="px-4 py-3 whitespace-nowrap">Follow-ups</th>
                <th className="px-4 py-3 whitespace-nowrap">Last Contacted</th>
                <th className="px-4 py-3 whitespace-nowrap">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-midnight-line/40">
              {history.map((lead) => (
                <tr key={lead.id} className="hover:bg-midnight-faint/50">
                  <td className="px-4 py-3 font-semibold text-midnight-ink">{leadTitle(lead)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-midnight-soft">{lead.email}</td>
                  <td className="px-4 py-3 max-w-[300px] truncate text-midnight-ink">
                    {lead.latestSubject || "—"}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className={`inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-[11px] uppercase tracking-wider ${
                      lead.latestMessageStatus === "sent"
                        ? "bg-emerald-faint text-emerald border-emerald"
                        : lead.latestMessageStatus === "draft"
                        ? "bg-midnight-faint text-midnight border-midnight"
                        : "bg-amber-faint text-amber border-amber"
                    }`}>
                      {lead.latestMessageStatus || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-midnight-soft">{lead.followup_count}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-midnight-soft">{formatDateTime(lead.latestMessageAt)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-midnight-soft">{formatDate(lead.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {lead.mainEmail && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => handleOpenInGmail(
                            lead.mainEmail!.message.id,
                            lead.email,
                            lead.mainEmail!.message.subject,
                            ""
                          )}
                          disabled={openingGmailId === lead.mainEmail!.message.id}
                        >
                          {openingGmailId === lead.mainEmail!.message.id ? "Opening…" : "Gmail"}
                        </button>
                      )}
                      <Link
                        href={`/drafts/${lead.mainEmail?.message.id}`}
                        className="btn btn-sm"
                      >
                        View
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {notice && (
        <div className={`notice ${notice.kind === "error" ? "notice-alarm" : "notice-info"}`} role="alert">
          {notice.text}
        </div>
      )}
    </div>
  );
}