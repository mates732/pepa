"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";

import { openGmailCompose } from "@/lib/outreach/open-gmail-compose";
import { updateDraft } from "@/app/update-draft-action";
import { loadDraftById } from "@/app/load-draft-action";
import { deleteOutreachMessage } from "@/app/actions";
import { formatDate, sequenceLabel } from "@/lib/utils/date";

interface Notice {
  kind: "info" | "error";
  text: string;
}

interface DraftData {
  ok: true;
  lead: {
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
  };
  message: {
    id: string;
    lead_id: string;
    recipient_email: string;
    subject: string | null;
    body: string | null;
    status: string;
    provider: string | null;
    provider_message_id: string | null;
    sent_at: string | null;
    created_at: string;
    sequence_number: number;
    parent_message_id: string | null;
  };
}

interface Props {
  initialDraft: DraftData;
}

export function DraftDetailClient({ initialDraft }: Props) {
  const [draft, setDraft] = useState<DraftData>(initialDraft);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editRecipient, setEditRecipient] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [openingGmail, setOpeningGmail] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadFreshDraft = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadDraftById(draft.message.id);
      if (result.ok) {
        setDraft(result);
      }
    } finally {
      setLoading(false);
    }
  }, [draft.message.id]);

  function startEditing() {
    setEditRecipient(draft.message.recipient_email);
    setEditSubject(draft.message.subject ?? "");
    setEditBody(draft.message.body ?? "");
    setEditError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setEditError(null);
  }

  async function handleSaveEdit() {
    setEditSaving(true);
    setEditError(null);
    setNotice(null);

    try {
      const result = await updateDraft({
        messageId: draft.message.id,
        recipientEmail: editRecipient,
        subject: editSubject,
        body: editBody,
      });

      if (!result.ok) {
        setEditError(result.error);
        return;
      }

      setNotice({ kind: "info", text: "Draft updated." });
      setEditing(false);
      await loadFreshDraft();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Failed to update draft.");
    } finally {
      setEditSaving(false);
    }
  }

  function handleOpenInGmail() {
    setOpeningGmail(true);
    setNotice(null);

    openGmailCompose({
      to: draft.message.recipient_email,
      subject: draft.message.subject,
      body: draft.message.body,
    });

    // Navigation happens synchronously in openGmailCompose via window.location.assign().
    // No notice needed — the browser navigates away.
  }

  async function handleDelete() {
    if (!window.confirm("Delete this draft? This cannot be undone.")) return;

    setDeleting(true);
    setNotice(null);
    try {
      const result = await deleteOutreachMessage({ messageId: draft.message.id });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setNotice({ kind: "info", text: "Draft deleted. Redirecting…" });
      setTimeout(() => window.location.href = "/drafts", 1000);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <Link href="/drafts" className="text-sm text-midnight-soft hover:text-midnight mb-2 inline-block">
            ← Back to Drafts
          </Link>
          <h1 className="heading-sticker text-2xl text-midnight">Draft Detail</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/drafts" className="btn btn-sm">Back to List</Link>
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.kind === "error" ? "notice-alarm" : "notice-info"}`} role="alert">
          {notice.text}
        </div>
      )}

      {loading ? (
        <div className="sticker p-8 text-center">
          <p className="text-midnight-soft">Loading…</p>
        </div>
      ) : (
        <>
          <section className="sticker" aria-labelledby="draft-meta-heading">
            <h2 id="draft-meta-heading" className="sticker-title">Message Info</h2>
            <dl className="p-5 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wider text-midnight-soft">Lead</dt>
                <dd className="font-semibold text-midnight-ink">
                  {draft.lead.company_name || draft.lead.contact_name || draft.lead.email}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-midnight-soft">Recipient</dt>
                <dd className="font-mono text-sm text-midnight">{draft.message.recipient_email}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-midnight-soft">Type</dt>
                <dd className="font-semibold text-midnight-ink">{sequenceLabel(draft.message.sequence_number)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-midnight-soft">Status</dt>
                <dd>
                  <span className={`inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-[11px] uppercase tracking-wider ${
                    draft.message.status === "draft"
                      ? "bg-midnight-faint text-midnight border-midnight"
                      : draft.message.status === "ready"
                      ? "bg-emerald-faint text-emerald border-emerald"
                      : "bg-amber-faint text-amber border-amber"
                  }`}>
                    {draft.message.status}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-midnight-soft">Created</dt>
                <dd className="text-sm text-midnight-soft">{formatDate(draft.message.created_at)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-midnight-soft">Lead Status</dt>
                <dd className="text-sm text-midnight-soft">{draft.lead.status}</dd>
              </div>
              {draft.message.parent_message_id && (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wider text-midnight-soft">Parent Message</dt>
                  <dd className="font-mono text-xs text-midnight-soft">{draft.message.parent_message_id}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="sticker" aria-labelledby="draft-content-heading">
            <h2 id="draft-content-heading" className="sticker-title">Content</h2>
            <div className="p-5 space-y-4">
              <div>
                <label className="field-label block mb-1">Subject</label>
                <p className="font-mono text-sm text-midnight bg-midnight-faint/30 px-3 py-2 rounded">{draft.message.subject || "(No subject)"}</p>
              </div>
              <div>
                <label className="field-label block mb-1">Body</label>
                <pre className="font-mono text-sm leading-relaxed bg-midnight-faint/30 px-3 py-2 rounded max-h-96 overflow-auto whitespace-pre-wrap">{draft.message.body || "(No body)"}</pre>
              </div>
            </div>
          </section>

          <section className="sticker" aria-labelledby="draft-actions-heading">
            <h2 id="draft-actions-heading" className="sticker-title">Actions</h2>
            <div className="p-5 flex flex-wrap gap-3">
              {editing ? (
                <>
                  <button type="button" onClick={handleSaveEdit} disabled={editSaving} className="btn btn-primary">
                    {editSaving ? "Saving…" : "Save Changes"}
                  </button>
                  <button type="button" onClick={cancelEditing} className="btn" disabled={editSaving}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={startEditing} className="btn btn-primary">Edit</button>
                  <button
                    type="button"
                    onClick={handleOpenInGmail}
                    disabled={openingGmail}
                    className="btn"
                  >
                    {openingGmail ? "Opening…" : "Open in Gmail"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="btn btn-destructive"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                </>
              )}
            </div>
          </section>

          {editing && (
            <section className="sticker" aria-labelledby="edit-form-heading">
              <h2 id="edit-form-heading" className="sticker-title">Edit Draft</h2>
              <div className="p-5 space-y-4">
                <div>
                  <label htmlFor="edit-recipient" className="field-label block mb-1">Recipient</label>
                  <input
                    id="edit-recipient"
                    type="email"
                    value={editRecipient}
                    onChange={(e) => setEditRecipient(e.target.value)}
                    disabled={editSaving}
                    className="field font-mono text-sm"
                    placeholder="info@example.com"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="edit-subject" className="field-label block mb-1">Subject</label>
                  <input
                    id="edit-subject"
                    type="text"
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    disabled={editSaving}
                    className="field font-mono text-sm"
                    placeholder="Subject line"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="edit-body" className="field-label block mb-1">Body</label>
                  <textarea
                    id="edit-body"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    disabled={editSaving}
                    rows={12}
                    spellCheck={false}
                    className="field resize-y font-mono text-sm leading-relaxed"
                    placeholder="Email body…"
                    required
                  />
                </div>
                {editError && (
                  <div className="notice notice-alarm">{editError}</div>
                )}
              </div>
            </section>
          )}
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