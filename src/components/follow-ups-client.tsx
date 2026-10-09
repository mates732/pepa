"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

import { openOutreachInGmail, loadFollowUps } from "@/app/actions";
import { buildComposeUrls } from "@/lib/outreach/gmail-compose-client";
import { formatDate, formatDateTime, sequenceLabel, leadTitle } from "@/lib/utils/date";

interface Notice {
  kind: "info" | "error";
  text: string;
}

interface FollowUpItem {
  message: {
    id: string;
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
  attention: 0 | 1 | 2;
}

interface Props {
  initialFollowUps: FollowUpItem[];
  initialError: string | null;
}

export function FollowUpsClient({ initialFollowUps, initialError }: Props) {
  const [followUps, setFollowUps] = useState<FollowUpItem[]>(initialFollowUps);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [openingGmailId, setOpeningGmailId] = useState<string | null>(null);
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

  async function handleOpenInGmail(item: FollowUpItem) {
    setOpeningGmailId(item.message.id);
    setNotice(null);

    const urls = buildComposeUrls({
      to: item.lead.email,
      subject: item.message.subject,
      body: item.message.body,
    });

    const tab = window.open(urls.web, "_blank", "noreferrer");

    if (!tab) {
      setNotice({
        kind: "error",
        text: `Your browser blocked the new tab. Open manually: ${urls.web}`,
      });
    } else {
      setNotice({
        kind: "info",
        text: `Opened Gmail compose. If it didn't open, use: ${urls.web}`,
      });
      try { tab.opener = null; } catch {}
    }

    setOpeningGmailId(null);
  }

  const draftFollowUps = followUps.filter((f) => f.message.status === "draft");
  const sentFollowUps = followUps.filter((f) => f.message.status === "sent");

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="heading-sticker text-2xl text-midnight">Follow-ups</h1>
        <p className="mt-1 text-sm text-midnight-soft">
          {followUps.length} follow-up{followUps.length === 1 ? "" : "s"} total
          {draftFollowUps.length > 0 && ` · ${draftFollowUps.length} draft`}
          {sentFollowUps.length > 0 && ` · ${sentFollowUps.length} sent`}
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
          <div className="flex flex-wrap gap-3 mb-4">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFollowUps(followUps)}
            >
              All ({followUps.length})
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFollowUps(draftFollowUps)}
            >
              Draft ({draftFollowUps.length})
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFollowUps(sentFollowUps)}
            >
              Sent ({sentFollowUps.length})
            </button>
          </div>

          <section className="sticker overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b-[3px] border-midnight text-left text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
                  <th className="px-4 py-3">Lead</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3 max-w-[300px]">Subject</th>
                  <th className="px-4 py-3 whitespace-nowrap">Seq</th>
                  <th className="px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="px-4 py-3 whitespace-nowrap">Created</th>
                  <th className="px-4 py-3 whitespace-nowrap">Sent</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-midnight-line/40">
                {followUps.map((item) => (
                  <tr key={item.message.id} className="hover:bg-midnight-faint/50">
                    <td className="px-4 py-3 font-semibold text-midnight-ink">{leadTitle(item.lead)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-midnight-soft">{item.lead.email}</td>
                    <td className="px-4 py-3 max-w-[300px] truncate text-midnight-ink">{item.message.subject || "—"}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs font-semibold text-midnight-soft">{sequenceLabel(item.message.sequence_number)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-[11px] uppercase tracking-wider ${
                        item.message.status === "sent"
                          ? "bg-emerald-faint text-emerald border-emerald"
                          : item.message.status === "draft"
                          ? "bg-midnight-faint text-midnight border-midnight"
                          : "bg-amber-faint text-amber border-amber"
                      }`}>
                        {item.message.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-midnight-soft">{formatDate(item.message.created_at)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-midnight-soft">{formatDateTime(item.message.sent_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => handleOpenInGmail(item)}
                          disabled={openingGmailId === item.message.id}
                        >
                          {openingGmailId === item.message.id ? "Opening…" : "Gmail"}
                        </button>
                        <Link
                          href={`/drafts/${item.message.id}`}
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