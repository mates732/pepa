"use client";

import { useState, useCallback } from "react";

import { parseBulkEmails } from "@/lib/import/bulk-emails";
import { saveDraftsFromPaste } from "@/app/save-drafts-action";

interface Notice {
  kind: "info" | "error";
  text: string;
}

interface ParseResult {
  candidates: Array<{
    recipient: string | null;
    subject: string | null;
    body: string | null;
    followUps: Array<{ subject: string | null; body: string | null }>;
    status: string;
    warnings: string[];
  }>;
  truncated: number;
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

function sequenceLabel(sequenceNumber: number): string {
  if (sequenceNumber <= 0) return "Initial";
  return `Follow-up #${sequenceNumber}`;
}

export function ParserClient() {
  const [pasteValue, setPasteValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [saveResult, setSaveResult] = useState<{
    created: number;
    existing: number;
    skipped: number;
    failed: number;
    details: Array<{ index: number; recipient: string | null; outcome: string; error: string | null }>;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const handleParse = useCallback(() => {
    const result = parseBulkEmails(pasteValue ?? "");
    setPreview(result);
    setSaveError(null);
    setSaveResult(null);
    setNotice(null);
  }, [pasteValue]);

  async function handleSave() {
    if (!pasteValue.trim()) {
      setSaveError("Nothing to save — paste your emails first.");
      return;
    }

    if (!preview || preview.candidates.length === 0) {
      setSaveError("Parse the content first — click \"Preview\".");
      return;
    }

    const validCandidates = preview.candidates.filter((c) => c.status === "parsed" && c.recipient);
    if (validCandidates.length === 0) {
      setSaveError("No valid emails with recipients found. Fix the input first.");
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
        setPreview(null);
      }

      setNotice({
        kind: "info",
        text: `${result.created} draft${result.created === 1 ? "" : "s"} created, ${result.existing} updated, ${result.skipped} skipped${result.failed > 0 ? `, ${result.failed} failed` : ""}.`,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save drafts.");
    } finally {
      setSaving(false);
    }
  }

  const totalInitial = preview?.candidates.filter((c) => c.status === "parsed" && c.recipient).length ?? 0;
  const totalFollowups = preview?.candidates.reduce((sum, c) => sum + (c.followUps?.length ?? 0), 0) ?? 0;
  const totalInvalid = preview?.candidates.filter((c) => c.status !== "parsed" || !c.recipient).length ?? 0;

  return (
    <div className="flex flex-col gap-7">
      <header>
        <h1 className="heading-sticker text-2xl text-midnight">Paste Emails</h1>
        <p className="mt-1 text-sm text-midnight-soft">
          Paste finished emails — one or multiple leads separated by <code className="font-mono">--- LEAD NN ---</code>
        </p>
      </header>

      <section className="sticker">
        <div className="sticker-title-row">
          <h2 className="sticker-title">1. Paste Content</h2>
        </div>
        <div className="p-5">
          <textarea
            id="parser-paste-input"
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleParse();
              }
            }}
            disabled={saving}
            rows={16}
            spellCheck={false}
            placeholder={EXAMPLE_INPUT}
            className="field resize-y font-mono text-[13px] leading-relaxed w-full"
          />

          <p className="mt-2 text-[11px] text-midnight-soft">
            Your text is used exactly as written. Pepa only reads recipient, subject, body, and follow-ups — it never rewrites or generates anything.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleParse}
              disabled={saving || !pasteValue.trim()}
              className="btn btn-primary"
            >
              {saving ? "Parsing…" : "Preview"}
            </button>
            <button type="button" onClick={() => setPasteValue("")} className="btn" disabled={saving}>
              Clear
            </button>
            <p className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
              ⌘ + ↵ to preview · Drafts only · You send every email yourself
            </p>
          </div>
        </div>
      </section>

      {preview && (
        <section className="sticker">
          <div className="sticker-title-row">
            <h2 className="sticker-title">2. Preview</h2>
          </div>
          <div className="p-5">
            <div className="flex flex-wrap gap-4 mb-4 text-sm">
              <span className="rounded-full border-2 border-midnight bg-midnight-faint px-3 py-1 text-midnight font-semibold">
                {totalInitial} initial email{totalInitial === 1 ? "" : "s"}
              </span>
              <span className="rounded-full border-2 border-midnight bg-midnight/15 px-3 py-1 text-midnight font-semibold">
                {totalFollowups} follow-up{totalFollowups === 1 ? "" : "s"}
              </span>
              {totalInvalid > 0 && (
                <span className="rounded-full border-2 border-midnight bg-midnight/65 px-3 py-1 text-cream font-semibold">
                  {totalInvalid} invalid/skipped
                </span>
              )}
            </div>

            {preview.candidates.map((candidate, idx) => (
              <div key={candidate.recipient ?? idx} className="mb-4 p-4 rounded-[0.75rem] border border-midnight-line/40 bg-midnight-faint/30">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="chip chip-solid text-xs">
                    {candidate.status === "parsed" ? "Valid" : candidate.status}
                  </span>
                  {candidate.recipient && (
                    <span className="font-mono text-sm text-midnight">{candidate.recipient}</span>
                  )}
                  {!candidate.recipient && (
                    <span className="text-sm text-red-600">Missing recipient</span>
                  )}
                </div>

                <div className="grid gap-2 text-sm">
                  <div>
                    <span className="font-medium text-midnight-soft">Subject:</span>
                    <span className="ml-2 font-mono text-midnight">{candidate.subject ?? "(none)"}</span>
                  </div>
                  <div>
                    <span className="font-medium text-midnight-soft">Body preview:</span>
                    <span className="ml-2 font-mono text-midnight line-clamp-2">{candidate.body?.slice(0, 120) ?? "(empty)"}</span>
                  </div>
                </div>

                {candidate.followUps && candidate.followUps.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-midnight-line/40">
                    <div className="text-xs font-medium text-midnight-soft mb-1">Follow-ups ({candidate.followUps.length}):</div>
                    <ul className="space-y-1">
                      {candidate.followUps.map((fu, fuIdx) => (
                        <li key={fuIdx} className="text-xs text-midnight font-mono">
                          <span className="text-midnight-soft">{sequenceLabel(fuIdx + 1)}:</span>{" "}
                          {fu.subject ?? "(no subject)"} — {fu.body?.slice(0, 80) ?? "(empty)"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {candidate.warnings && candidate.warnings.length > 0 && (
                  <div className="mt-2 text-xs text-amber-700 bg-amber-50/80 p-2 rounded">
                    {candidate.warnings.join("; ")}
                  </div>
                )}
              </div>
            ))}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || totalInitial === 0}
                className="btn btn-primary"
              >
                {saving ? "Saving…" : `Save ${totalInitial} draft${totalInitial === 1 ? "" : "s"}`}
              </button>
              <button type="button" onClick={() => { setPasteValue(""); setPreview(null); }} className="btn" disabled={saving}>
                Clear All
              </button>
            </div>
          </div>
        </section>
      )}

      {saveError && (
        <div className="notice notice-alarm" role="alert">{saveError}</div>
      )}

      {saveResult && (
        <div className="sticker rounded-[1.25rem] border-[3px] border-midnight bg-midnight-faint/40 p-4">
          <p className="text-sm font-black uppercase tracking-wide text-midnight mb-2">
            {saveResult.created + saveResult.existing} draft{saveResult.created + saveResult.existing === 1 ? "" : "s"} ready
          </p>
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider">
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

      {notice && (
        <div className={`notice ${notice.kind === "error" ? "notice-alarm" : "notice-info"}`} role="alert">
          {notice.text}
        </div>
      )}
    </div>
  );
}