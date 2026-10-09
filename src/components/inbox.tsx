"use client";

import { useCallback, useEffect, useState } from "react";

import { saveDraftsFromPaste } from "@/app/save-drafts-action";
import { loadDraftById } from "@/app/load-draft-action";
import { updateDraft } from "@/app/update-draft-action";
import { buildComposeUrls } from "@/lib/outreach/gmail-compose-client";
import { deleteOutreachMessage, loadOutreachDraftRows as loadOutreachDraftRowsAction } from "@/app/actions";
import type { OutreachDraftRow } from "@/lib/services/outreach-service";
import { preopenComposeWindow, navigateComposeWindow, closeComposeWindow } from "@/lib/outreach/open-compose-window";

interface Notice {
  kind: "info" | "error";
  text: string;
}

function sequenceLabel(sequenceNumber: number): string {
  if (sequenceNumber <= 0) return "Initial";
  return `Follow-up #${sequenceNumber}`;
}

function draftTitle(draft: OutreachDraftRow): string {
  return draft.lead.company_name || draft.lead.contact_name || draft.lead.email;
}

export function Inbox() {
  const [pasteValue, setPasteValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    created: number;
    existing: number;
    skipped: number;
    failed: number;
    details: Array<{ index: number; recipient: string | null; outcome: string; error: string | null }>;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<OutreachDraftRow[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [openingGmailId, setOpeningGmailId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRecipient, setEditRecipient] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const loadDrafts = useCallback(async () => {
    setDraftsLoading(true);
    setDraftsError(null);
    try {
      const result = await loadOutreachDraftRowsAction();
      if (result.ok) {
        setDrafts(result.drafts);
        setDraftsError(null);
      } else {
        setDraftsError(result.error);
      }
    } finally {
      setDraftsLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => {
      loadDrafts();
    }, 0);
    return () => clearTimeout(handle);
  }, [loadDrafts]);

  async function handleSave() {
    if (!pasteValue.trim()) {
      setSaveError("Nothing to save — paste your emails first.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    setNotice(null);

    try {
      const result = await saveDraftsFromPaste(pasteValue);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }

      setSaveResult({
        created: result.created,
        existing: result.existing,
        skipped: result.skipped,
        failed: result.failed,
        details: result.details,
      });

      if (result.created > 0 || result.existing > 0) {
        setPasteValue("");
      }

      setNotice({
        kind: "info",
        text: `${result.created} draft${result.created === 1 ? "" : "s"} created, ${result.existing} updated, ${result.skipped} skipped${result.failed > 0 ? `, ${result.failed} failed` : ""}.`,
      });

      await loadDrafts();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save drafts.");
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenInGmail(messageId: string, draft: OutreachDraftRow) {
    setOpeningGmailId(messageId);
    setNotice(null);

    // Build URL client-side from draft data we already have - no async wait needed
    const urls = buildComposeUrls({
      to: draft.message.recipient_email,
      subject: draft.message.subject,
      body: draft.message.body,
    });

    // Open window synchronously during user gesture
    const tab = preopenComposeWindow();
    if (!tab) {
      setNotice({
        kind: "error",
        text: `Your browser blocked the new tab. Open manually: ${urls.web}`,
      });
      setOpeningGmailId(null);
      return;
    }

    try {
      // Navigate immediately - no await, URL is already known
      const navigated = navigateComposeWindow(tab, urls.web);
      if (!navigated) {
        closeComposeWindow(tab);
        setNotice({
          kind: "error",
          text: `Your browser blocked the new tab. Open manually: ${urls.web}`,
        });
      } else {
        setNotice({
          kind: "info",
          text: "Opened Gmail compose with the draft.",
        });
      }
    } catch {
      closeComposeWindow(tab);
      setNotice({
        kind: "error",
        text: `Failed to open Gmail. Open manually: ${urls.web}`,
      });
    } finally {
      setOpeningGmailId(null);
    }
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

  async function handleOpenDraft(messageId: string) {
    setOpeningId(messageId);
    setEditLoading(true);
    setEditError(null);
    try {
      const result = await loadDraftById(messageId);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }

      // Populate editor fields
      setEditingId(messageId);
      setEditRecipient(result.message.recipient_email);
      setEditSubject(result.message.subject ?? "");
      setEditBody(result.message.body ?? "");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to load draft." });
    } finally {
      setOpeningId(null);
      setEditLoading(false);
    }
  }

  function closeEditor() {
    setEditingId(null);
    setEditRecipient("");
    setEditSubject("");
    setEditBody("");
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editingId) return;

    setEditSaving(true);
    setEditError(null);
    setNotice(null);

    try {
      const result = await updateDraft({
        messageId: editingId,
        recipientEmail: editRecipient,
        subject: editSubject,
        body: editBody,
      });

      if (!result.ok) {
        setEditError(result.error);
        return;
      }

      setNotice({ kind: "info", text: "Draft updated." });
      closeEditor();
      await loadDrafts();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Failed to update draft.");
    } finally {
      setEditSaving(false);
    }
  }

  const EXAMPLE_INPUT = `--- LEAD 01 ---
Email: info@firma1.cz
Subject: Nabídka spolupráce
Body:
Dobrý den,

rád bych Vám představil naši nabídku.

S pozdravem
Petr

Follow-up Subject: Re: Nabídka spolupráce
Follow-up Body:
Dobrý den,

jen se ozvu, zda jste měl čas se podívat na nabídku.

S pozdravem
Petr

--- LEAD 02 ---
Email: kontakt@firma2.cz
Subject: AI recepce pro Váš salon
Body:
Dobrý den,

nabízíme AI recepci, která zodpoví všem hovorům.

S pozdravem
Petr`;

  return (
    <div className="flex flex-col gap-7">
      <section className="sticker">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <h2 className="heading-sticker text-base text-midnight">
            <span className="chip chip-solid mr-2 align-middle">1</span>
            Paste Emails
          </h2>
        </div>

        <div className="p-5">
          <label htmlFor="inbox-paste-input" className="field-label block mb-2">
            Finished emails — separated by <code className="font-mono">--- LEAD NN ---</code>
          </label>
          <textarea
            id="inbox-paste-input"
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleSave();
              }
            }}
            disabled={saving}
            rows={14}
            spellCheck={false}
            placeholder={EXAMPLE_INPUT}
            className="field resize-y font-mono text-[13px] leading-relaxed w-full"
          />

          <p className="mt-2 text-[11px] text-midnight-soft">
            Your text is used exactly as written. Pepa only reads recipient, subject, body, and follow-ups — it never rewrites or generates anything.
          </p>

          {(saveError || (saveResult && saveResult.failed > 0)) && (
            <div className="notice notice-alarm mt-4">
              {saveError ?? `${saveResult!.failed} email(s) could not be saved.`}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !pasteValue.trim()}
              className="btn btn-primary"
            >
              {saving ? "Saving…" : "Save drafts"}
            </button>
            <button type="button" onClick={() => setPasteValue("")} className="btn" disabled={saving}>
              Clear
            </button>
            <p className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
              ⌘ + ↵ to save · Drafts only · You send every email yourself
            </p>
          </div>

          {saveResult && saveResult.created + saveResult.existing > 0 && (
            <div className="mt-4 rounded-[1.25rem] border-[3px] border-midnight px-4 py-3 bg-midnight-faint/40">
              <p className="text-sm font-black uppercase tracking-wide text-midnight">
                {saveResult.created + saveResult.existing} draft{saveResult.created + saveResult.existing === 1 ? "" : "s"} ready
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider">
                <span className="rounded-full border-2 border-midnight bg-midnight-faint px-2 py-0.5 text-midnight">
                  {saveResult.created} created
                </span>
                <span className="rounded-full border-2 border-midnight bg-midnight/15 px-2 py-0.5 text-midnight">
                  {saveResult.existing} updated
                </span>
                {saveResult.skipped > 0 && (
                  <span className="rounded-full border-2 border-midnight bg-midnight/35 px-2 py-0.5 text-midnight">
                    {saveResult.skipped} skipped
                  </span>
                )}
                {saveResult.failed > 0 && (
                  <span className="rounded-full border-2 border-midnight bg-midnight/65 px-2 py-0.5 text-cream">
                    {saveResult.failed} failed
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="sticker">
        <div className="sticker-title-row">
          <h2 className="sticker-title">Drafts ({drafts.length})</h2>
        </div>

        {draftsLoading ? (
          <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
            Loading drafts…
          </p>
        ) : draftsError ? (
          <p className="m-5 rounded-[1.25rem] border-[3px] border-red-300 bg-red-50/80 px-5 py-4 text-sm font-semibold text-red-700">
            {draftsError}
          </p>
        ) : drafts.length === 0 ? (
          <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
            No drafts yet. Paste emails above and click &ldquo;Save drafts&rdquo;.
          </p>
        ) : (
          <ul className="divide-y divide-midnight-line/40">
            {drafts.map((draft) => {
              const title = draftTitle(draft);
              const isOpening = openingId === draft.message.id;
              const isOpeningGmail = openingGmailId === draft.message.id;
              const isDeleting = deletingId === draft.message.id;
              const isEditing = editingId === draft.message.id;

              return (
                <li key={draft.message.id} className="px-5 py-4">
                  <p className="text-sm font-semibold text-midnight-ink">{title}</p>
                  <p className="text-xs text-midnight-soft">{draft.message.recipient_email}</p>
                  <p className="mt-1 text-sm text-midnight-ink">{draft.message.subject || "(No subject)"}</p>
                  <p className="mt-1 text-xs font-semibold text-midnight-soft">
                    {sequenceLabel(draft.message.sequence_number)}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => handleOpenDraft(draft.message.id)}
                      disabled={isOpening || isDeleting || isOpeningGmail || isEditing}
                    >
                      {isOpening ? "Opening…" : isEditing ? "Editing…" : "Open / Edit"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => handleOpenInGmail(draft.message.id, draft)}
                      disabled={isOpeningGmail || isDeleting || isOpening || isEditing}
                    >
                      {isOpeningGmail ? "Opening…" : "Open in Gmail"}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => handleDelete(draft.message.id)}
                      disabled={isDeleting || isOpening || isOpeningGmail || isEditing}
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {notice && (
          <div className={`notice ${notice.kind === "error" ? "notice-alarm" : "notice-info"} m-5`}>
            {notice.text}
          </div>
        )}
      </section>

      {/* Editor Dialog */}
      {editingId && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-midnight/40 px-4 py-8">
          <div className="absolute inset-0" onClick={closeEditor} aria-hidden />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Edit draft"
            className="sticker relative w-full max-w-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
              <h3 className="heading-sticker text-base text-midnight">
                Edit Draft
              </h3>
              <button
                type="button"
                onClick={closeEditor}
                className="btn btn-sm"
                aria-label="Close"
                disabled={editSaving}
              >
                Close
              </button>
            </header>

            <div className="p-5">
              {editLoading ? (
                <p className="text-center text-midnight-soft py-8">Loading draft…</p>
              ) : (
                <>
                  <div className="mb-4">
                    <label htmlFor="edit-recipient" className="field-label block mb-1">
                      Recipient
                    </label>
                    <input
                      id="edit-recipient"
                      type="email"
                      value={editRecipient}
                      onChange={(e) => setEditRecipient(e.target.value)}
                      disabled={editSaving}
                      className="field font-mono text-[13px]"
                      placeholder="info@example.com"
                    />
                  </div>

                  <div className="mb-4">
                    <label htmlFor="edit-subject" className="field-label block mb-1">
                      Subject
                    </label>
                    <input
                      id="edit-subject"
                      type="text"
                      value={editSubject}
                      onChange={(e) => setEditSubject(e.target.value)}
                      disabled={editSaving}
                      className="field font-mono text-[13px]"
                      placeholder="Subject line"
                    />
                  </div>

                  <div className="mb-4">
                    <label htmlFor="edit-body" className="field-label block mb-1">
                      Body
                    </label>
                    <textarea
                      id="edit-body"
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      disabled={editSaving}
                      rows={10}
                      spellCheck={false}
                      className="field resize-y font-mono text-[13px] leading-relaxed"
                      placeholder="Email body…"
                    />
                  </div>

                  {editError && (
                    <div className="notice notice-alarm mb-4">{editError}</div>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSaveEdit}
                      disabled={editSaving}
                      className="btn btn-primary"
                    >
                      {editSaving ? "Saving…" : "Save changes"}
                    </button>
                    <button type="button" onClick={closeEditor} className="btn" disabled={editSaving}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}