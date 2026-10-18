"use client";

import { useState, useCallback, useEffect } from "react";

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

rád bych Vám představit naši nabídku.

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

type LeadStatus =
  | "parsed"
  | "validating"
  | "checking-history"
  | "saving-draft"
  | "verified"
  | "created"
  | "updated"
  | "skipped"
  | "failed";

interface LeadStatusInfo {
  status: LeadStatus;
  reason?: string;
}

interface ParserClientProps {
  onImportComplete?: () => void;
}

interface LeadStatusInfo {
  status: LeadStatus;
  reason?: string;
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
    details: Array<{
      index: number;
      recipient: string | null;
      outcome: string;
      error: string | null;
    }>;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Live per-lead status tracking
  const [leadStatuses, setLeadStatuses] = useState<
    Array<{ index: number; status: LeadStatus; reason?: string }>
  >();

  const [processingCounters, setProcessingCounters] = useState({
    parsed: 0,
    processing: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  });

  const handleParse = useCallback(() => {
    const result = parseBulkEmails(pasteValue ?? "");
    setPreview(result);
    setSaveError(null);
    setSaveResult(null);
    setNotice(null);
    // Reset lead statuses on new parse
    setLeadStatuses(
      result.candidates.map((_, idx) => ({
        index: idx,
        status: "parsed",
        reason: null,
      }))
    );
    setProcessingCounters({
      parsed: result.candidates.filter(
        (c) => c.status === "parsed" && c.recipient,
      ).length,
      processing: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
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

    const validCandidates = preview.candidates.filter(
      (c) => c.status === "parsed" && c.recipient,
    );
    if (validCandidates.length === 0) {
      setSaveError("No valid emails with recipients found. Fix the input first.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    setNotice(null);

    // Initialize lead statuses
    setLeadStatuses(
      preview.candidates.map((_, idx) => ({
        index: idx,
        status: "parsed",
        reason: null,
      }))
    );
    setProcessingCounters({
      parsed: validCandidates.length,
      processing: validCandidates.length,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    });

    try {
      const result = await saveDraftsFromPaste(pasteValue);
      
      if (!result.ok) {
        setSaveError(result.error);
        setLeadStatuses(
          leadStatuses.map((ls) => ({
            ...ls,
            status: "failed",
            reason: result.error,
          }))
        );
        setProcessingCounters({
          parsed: leadStatuses.length,
          processing: 0,
          created: 0,
          updated: 0,
          skipped: leadStatuses.length,
          failed: leadStatuses.length,
        });
        return;
      }

      // Update lead statuses based on results
      const updatedLeadStatuses = leadStatuses.map((ls, i) => {
        const detail = result.details.find((d) => d.index === ls.index);
        if (!detail) return ls;
        
        const outcome = detail.outcome;
        if (outcome === "created") return { ...ls, status: "created", reason: null };
        if (outcome === "already_present") return { ...ls, status: "updated", reason: null };
        if (outcome === "skipped") return { ...ls, status: "skipped", reason: detail.error };
        if (outcome === "failed") return { ...ls, status: "failed", reason: detail.error };
        return ls;
      });
      
      setLeadStatuses(updatedLeadStatuses);
      
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
      
      // Mark all leads as failed
      setLeadStatuses(
        leadStatuses.map((ls) => ({
          ...ls,
          status: "failed",
          reason: error instanceof Error ? error.message : "Failed to save drafts.",
        }))
      );
      setProcessingCounters({
        parsed: leadStatuses.length,
        processing: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: leadStatuses.length,
      });
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
        <h1 className="heading-sticker text-xl text-midnight">Paste Emails</h1>
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
              <span className="rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-accent-strong font-semibold">
                {totalInitial} initial email{totalInitial === 1 ? "" : "s"}
              </span>
              <span className="rounded-full border border-midnight-line-strong bg-midnight-faint px-3 py-1 text-midnight font-semibold">
                {totalFollowups} follow-up{totalFollowups === 1 ? "" : "s"}
              </span>
              {totalInvalid > 0 && (
                <span className="rounded-full border border-error-line bg-error-soft px-3 py-1 text-error-ink font-semibold">
                  {totalInvalid} invalid/skipped
                </span>
              )}
            </div>

            {preview.candidates.map((candidate, idx) => (
              <div key={candidate.recipient ?? idx} className="mb-4 p-4 rounded-blob border border-midnight-line bg-midnight-faint/40">
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
                      ))
                    </ul>
                  </div>
                )}

                {candidate.warnings && candidate.warnings.length > 0 && (
                  <div className="mt-2 text-xs text-warning-ink bg-warning-soft p-2 rounded">
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
        <div className="sticker rounded-blob border border-midnight-line bg-midnight-faint/40 p-4">
          <p className="text-sm font-bold uppercase tracking-wide text-midnight mb-2">
            {saveResult.created + saveResult.existing} draft{saveResult.created + saveResult.existing === 1 ? "" : "s"} ready
          </p>
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider">
            <span className="rounded-full border border-success-line bg-success-soft px-2 py-0.5 text-success-ink">
              {saveResult.created} created
            </span>
            <span className="rounded-full border border-midnight-line-strong bg-midnight-faint px-2 py-0.5 text-midnight">
              {saveResult.existing} updated
            </span>
            {saveResult.skipped > 0 && (
              <span className="rounded-full border border-warning-line bg-warning-soft px-2 py-0.5 text-warning-ink">
                {saveResult.skipped} skipped
              </span>
            )}
            {saveResult.failed > 0 && (
              <span className="rounded-full border border-error-line bg-error-soft px-2 py-0.5 text-error-ink">
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

      {/* Live per-lead status panel */}
      {leadStatuses && leadStatuses.length > 0 && (
        <section className="sticker">
          <div className="sticker-title-row">
            <h2 className="sticker-title">3. Processing Status</h2>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-6 gap-2 mb-4">
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Lead</span>
                <span>Status</span>
                <span>Reason</span>
              </div>
              {leadStatuses.map((ls) => (
                <div key={ls.index} className="col-span-6 p-2 border border-midnight-line/20 rounded">
                  <span className="font-mono text-xs text-midnight lead-index">
                    Lead {ls.index + 1}
                  </span>
                  <span className="font-medium text-midnight status-badge {
                    ls.status === "parsed"
                      ? "text-midnight"
                      : ls.status === "validating"
                        ? "text-warning-ink"
                        : ls.status === "checking-history"
                          ? "text-midnight"
                          : ls.status === "saving-draft"
                            ? "text-accent-ink"
                            : ls.status === "verified"
                              ? "text-success-ink"
                              : ls.status === "created"
                                ? "text-success-ink"
                                : ls.status === "updated"
                                  ? "text-success-ink"
                                  : ls.status === "skipped"
                                    ? "text-warning-ink"
                                    : "text-error-ink"
                  }">
                    {ls.status}
                  </span>
                  <span className="text-xs text-muted-rose ml-2 {
                    ls.reason
                      ? "text-error-ink"
                      : "text-midnight-soft"
                  }">
                    {ls.reason ?? ""}
                  </span>
                </div>
              ))}
            </div>
            
            <div className="grid grid-cols-6 gap-2">
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Parsed</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "parsed").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Processing</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "saving-draft").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Created</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "created").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Updated</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "updated").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Skipped</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "skipped").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Failed</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "failed").length}</span>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
EOF
cp /dev/null src/components/parser-client.tsx
echo "File cleanup"