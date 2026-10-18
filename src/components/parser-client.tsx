"use client";

import { useState, useCallback } from "react";
import Link from "next/link";

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
  | "idle"
  | "processing"
  | "created"
  | "updated"
  | "unchanged"
  | "skipped_duplicate"
  | "skipped_already_contacted"
  | "rejected_invalid"
  | "failed";

const OUTCOME_LABELS: Record<string, { label: string; color: string; description: string }> = {
  created: {
    label: "Vytvořeno",
    color: "bg-success-soft text-success-ink border-success-line",
    description: "Nový draft byl úspěšně uložen.",
  },
  updated: {
    label: "Aktualizováno",
    color: "bg-accent-soft text-accent-ink border-accent-line",
    description: "Existující draft byl aktualizován novým obsahem.",
  },
  unchanged: {
    label: "Beze změny",
    color: "bg-midnight-faint text-midnight border-midnight-line",
    description: "Draft již existoval se stejným obsahem — nic se nezměnilo.",
  },
  skipped_duplicate: {
    label: "Přeskočeno (duplicitní)",
    color: "bg-warning-soft text-warning-ink border-warning-line",
    description: "Stejný příjemce už v tomto vložení byl — importován jen jednou.",
  },
  skipped_already_contacted: {
    label: "Přeskočeno (již kontaktováno)",
    color: "bg-error-soft text-error-ink border-error-line",
    description: "Historie outreachu zabraňuje novému cold outreachi na tuto adresu.",
  },
  rejected_invalid: {
    label: "Zamítnuto (neplatné)",
    color: "bg-error-soft text-error-ink border-error-line",
    description: "Chybí příjemce, nesprávný formát nebo jiná chyba validace.",
  },
  failed: {
    label: "Chyba",
    color: "bg-error-soft text-error-ink border-error-line",
    description: "Nastala chyba při ukládání. Zkuste to znovu.",
  },
};

const OUTCOME_ORDER = [
  "created",
  "updated",
  "unchanged",
  "skipped_duplicate",
  "skipped_already_contacted",
  "rejected_invalid",
  "failed",
] as const;

export function ParserClient() {
  const [pasteValue, setPasteValue] = useState("");
  const [processing, setProcessing] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [processResult, setProcessResult] = useState<{
    created: number;
    updated: number;
    unchanged: number;
    skipped_duplicate: number;
    skipped_already_contacted: number;
    rejected_invalid: number;
    failed: number;
    details: Array<{
      index: number;
      recipient: string | null;
      outcome: string;
      messageId: string | null;
      leadId: string | null;
      error: string | null;
    }>;
  } | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  // Live per-lead status tracking
  const [leadStatuses, setLeadStatuses] = useState<
    Array<{ index: number; status: LeadStatus; reason?: string | null }>
  >();

  async function handleProcess() {
    if (!pasteValue.trim()) {
      setProcessError("Nothing to process — paste your emails first.");
      return;
    }

    const parsed = parseBulkEmails(pasteValue ?? "");
    if (parsed.candidates.length === 0) {
      setProcessError("Nothing to parse — no valid emails found.");
      return;
    }

    const validCandidates = parsed.candidates.filter(
      (c) => c.status === "parsed" && c.recipient,
    );
    if (validCandidates.length === 0) {
      setProcessError("No valid emails with recipients found. Fix the input first.");
      return;
    }

    setProcessing(true);
    setProcessError(null);
    setProcessResult(null);
    setNotice(null);

    // Initialize lead statuses
    setLeadStatuses(
      parsed.candidates.map((_, idx) => ({
        index: idx,
        status: "idle",
        reason: null,
      }))
    );

    try {
      const statuses = leadStatuses ?? [];
      const result = await saveDraftsFromPaste(pasteValue);

      if (!result.ok) {
        setProcessError(result.error);
        setLeadStatuses(
          statuses.map((ls) => ({
            index: ls.index,
            status: "failed" as const,
            reason: result.error,
          }))
        );
        return;
      }

      // Update lead statuses based on results
      const updatedLeadStatuses = statuses.map((ls) => {
        const detail = result.details.find((d) => d.index === ls.index);
        if (!detail) return ls;

        const outcome = detail.outcome;
        if (outcome === "created")
          return { index: ls.index, status: "created" as const, reason: null };
        if (outcome === "updated")
          return { index: ls.index, status: "updated" as const, reason: null };
        if (outcome === "unchanged")
          return { index: ls.index, status: "unchanged" as const, reason: null };
        if (outcome === "skipped_duplicate")
          return { index: ls.index, status: "skipped_duplicate" as const, reason: detail.error };
        if (outcome === "skipped_already_contacted")
          return { index: ls.index, status: "skipped_already_contacted" as const, reason: detail.error };
        if (outcome === "rejected_invalid")
          return { index: ls.index, status: "rejected_invalid" as const, reason: detail.error };
        if (outcome === "failed")
          return { index: ls.index, status: "failed" as const, reason: detail.error };
        return ls;
      });

      setLeadStatuses(updatedLeadStatuses);

      setProcessResult({
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        skipped_duplicate: result.skipped_duplicate,
        skipped_already_contacted: result.skipped_already_contacted,
        rejected_invalid: result.rejected_invalid,
        failed: result.failed,
        details: result.details,
      });

      if (result.created > 0 || result.updated > 0 || result.unchanged > 0) {
        setPasteValue("");
      }

      const totalSuccess = result.created + result.updated + result.unchanged;
      const parts = [
        totalSuccess > 0 && `${totalSuccess} draft${totalSuccess === 1 ? "" : "y"} připraven${totalSuccess === 1 ? "" : "e"}`,
        result.skipped_duplicate > 0 && `${result.skipped_duplicate} duplicitn${result.skipped_duplicate === 1 ? "í" : "ích"}`,
        result.skipped_already_contacted > 0 && `${result.skipped_already_contacted} již kontaktovan${result.skipped_already_contacted === 1 ? "ý" : "ých"}`,
        result.rejected_invalid > 0 && `${result.rejected_invalid} neplatn${result.rejected_invalid === 1 ? "ý" : "ých"}`,
        result.failed > 0 && `${result.failed} chyb${result.failed === 1 ? "a" : result.failed < 5 ? "y" : ""}`,
      ].filter(Boolean);

      setNotice({
        kind: result.failed > 0 ? "error" : "info",
        text: parts.join(", ") + ".",
      });
    } catch (error) {
      const statuses = leadStatuses ?? [];
      setProcessError(error instanceof Error ? error.message : "Failed to process drafts.");

      setLeadStatuses(
        statuses.map((ls) => ({
          index: ls.index,
          status: "failed" as const,
          reason: error instanceof Error ? error.message : "Failed to process drafts.",
        }))
      );
    } finally {
      setProcessing(false);
    }
  }

  const parsed = parseBulkEmails(pasteValue ?? "");
  const totalInitial = parsed.candidates.filter((c) => c.status === "parsed" && c.recipient).length ?? 0;
  const totalFollowups = parsed.candidates.reduce((sum, c) => sum + (c.followUps?.length ?? 0), 0) ?? 0;
  const totalInvalid = parsed.candidates.filter((c) => c.status !== "parsed" || !c.recipient).length ?? 0;
  const hasPreview = parsed.candidates.length > 0;

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
          <h2 className="sticker-title">Paste & Process</h2>
        </div>
        <div className="p-5">
          <textarea
            id="parser-paste-input"
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (!processing && pasteValue.trim()) handleProcess();
              }
            }}
            disabled={processing}
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
              onClick={handleProcess}
              disabled={processing || !pasteValue.trim()}
              className="btn btn-primary"
            >
              {processing ? "Zpracovává se…" : "Zpracovat"}
            </button>
            <button type="button" onClick={() => { setPasteValue(""); setProcessResult(null); setProcessError(null); setLeadStatuses(undefined); }} className="btn" disabled={processing}>
              Vymazat
            </button>
            <p className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
              ⌘ + ↵ pro zpracování · Drafts only · You send every email yourself
            </p>
          </div>
        </div>
      </section>

      {/* Optional collapsible preview */}
      {hasPreview && (
        <section className="sticker">
          <button
            type="button"
            onClick={() => setPreviewExpanded(!previewExpanded)}
            className="sticker-title-row flex w-full items-center justify-between gap-3 px-5 py-3 text-left"
            aria-expanded={previewExpanded}
            aria-controls="parser-preview"
          >
            <h2 className="sticker-title flex items-center gap-2">
              <svg
                className={`w-5 h-5 text-midnight-soft transition-transform ${previewExpanded ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Zobrazit rozpoznané e-maily ({parsed.candidates.length} bloků)
            </h2>
          </button>

          <div
            id="parser-preview"
            className={`overflow-hidden transition-all duration-200 ${previewExpanded ? "max-h-max opacity-100" : "max-h-0 opacity-0"}`}
            style={{ maxHeight: previewExpanded ? "none" : "0" }}
          >
            <div className="px-5 pb-5 pt-0" aria-hidden={!previewExpanded}>
              <div className="flex flex-wrap gap-4 mb-4 text-sm">
                <span className="rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-accent-strong font-semibold">
                  {parsed.candidates.filter((c) => c.status === "parsed" && c.recipient).length ?? 0} initial email{totalInitial === 1 ? "" : "s"}
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

              {parsed.candidates.map((candidate, idx) => (
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
                        ))}
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
            </div>
          </div>
        </section>
      )}

      {processError && (
        <div className="notice notice-alarm" role="alert">{processError}</div>
      )}

      {processResult && (
        <section className="sticker rounded-blob border border-midnight-line bg-midnight-faint/40 p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div>
              <p className="text-sm font-bold uppercase tracking-wide text-midnight">
                {processResult.created + processResult.updated + processResult.unchanged} draft{processResult.created + processResult.updated + processResult.unchanged === 1 ? "" : "y"} připraven{processResult.created + processResult.updated + processResult.unchanged === 1 ? "" : "é"}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider mt-1">
                {processResult.created > 0 && (
                  <span className="rounded-full border border-success-line bg-success-soft px-2 py-0.5 text-success-ink">
                    {processResult.created} vytvořen{processResult.created === 1 ? "" : "y"}
                  </span>
                )}
                {processResult.updated > 0 && (
                  <span className="rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-accent-ink">
                    {processResult.updated} aktualizován{processResult.updated === 1 ? "" : "y"}
                  </span>
                )}
                {processResult.unchanged > 0 && (
                  <span className="rounded-full border border-midnight-line-strong bg-midnight-faint px-2 py-0.5 text-midnight">
                    {processResult.unchanged} beze změny
                  </span>
                )}
                {processResult.skipped_duplicate > 0 && (
                  <span className="rounded-full border border-warning-line bg-warning-soft px-2 py-0.5 text-warning-ink">
                    {processResult.skipped_duplicate} duplicitn{processResult.skipped_duplicate === 1 ? "í" : "ích"}
                  </span>
                )}
                {processResult.skipped_already_contacted > 0 && (
                  <span className="rounded-full border border-error-line bg-error-soft px-2 py-0.5 text-error-ink">
                    {processResult.skipped_already_contacted} již kontaktován{processResult.skipped_already_contacted === 1 ? "ý" : "í"}
                  </span>
                )}
                {processResult.rejected_invalid > 0 && (
                  <span className="rounded-full border border-error-line bg-error-soft px-2 py-0.5 text-error-ink">
                    {processResult.rejected_invalid} neplatn{processResult.rejected_invalid === 1 ? "ý" : "é"}
                  </span>
                )}
                {processResult.failed > 0 && (
                  <span className="rounded-full border border-error-line bg-error-soft px-2 py-0.5 text-error-ink">
                    {processResult.failed} chyb{processResult.failed === 1 ? "a" : processResult.failed < 5 ? "y" : ""}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/drafts" className="btn btn-primary">
                Otevřít drafty ({processResult.created + processResult.updated + processResult.unchanged})
              </Link>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-midnight-soft border-b border-midnight-line">
                  <th className="pb-2 px-2">#</th>
                  <th className="pb-2 px-2">Příjemce</th>
                  <th className="pb-2 px-2">Předmět</th>
                  <th className="pb-2 px-2">Výsledek</th>
                  <th className="pb-2 px-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {processResult.details
                  .sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome as any) - OUTCOME_ORDER.indexOf(b.outcome as any))
                  .map((detail) => {
                    const outcomeInfo = OUTCOME_LABELS[detail.outcome] || {
                      label: detail.outcome,
                      color: "bg-midnight-faint text-midnight border-midnight-line",
                      description: "Neznámý výsledek.",
                    };
                    return (
                      <tr key={detail.index} className="border-b border-midnight-line/20 hover:bg-midnight-faint/20">
                        <td className="py-2 px-2 font-mono text-xs text-midnight">{detail.index}</td>
                        <td className="py-2 px-2 font-mono text-sm text-midnight">{detail.recipient ?? "—"}</td>
                        <td className="py-2 px-2 text-midnight max-w-xs truncate">{detail.messageId ? "Draft" : "—"}</td>
                        <td className="py-2 px-2">
                          <span className={`chip chip-solid text-xs ${outcomeInfo.color}`}>
                            {outcomeInfo.label}
                          </span>
                        </td>
                        <td className="py-2 px-2">
                          <div className="flex items-center gap-2">
                            {detail.messageId && (
                              <Link
                                href={`/drafts/${detail.messageId}`}
                                className="text-xs text-accent-strong hover:underline font-mono"
                                title="Otevřít draft v detailu"
                              >
                                Otevřít draft
                              </Link>
                            )}
                            {detail.error && (
                              <span className="text-xs text-error-ink" title={detail.error}>
                                {detail.error.length > 60 ? detail.error.slice(0, 60) + "…" : detail.error}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
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
            <h2 className="sticker-title">Stav zpracování</h2>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-6 gap-2 mb-4">
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Lead</span>
                <span>Stav</span>
                <span>Důvod</span>
              </div>
              {leadStatuses.map((ls) => (
                <div key={ls.index} className="col-span-6 p-2 border border-midnight-line/20 rounded">
                  <span className="font-mono text-xs text-midnight lead-index">
                    Lead {ls.index + 1}
                  </span>
                  <span className={`font-medium text-midnight status-badge ${
                    ls.status === "idle"
                      ? "text-midnight-soft"
                      : ls.status === "processing"
                        ? "text-warning-ink"
                        : ls.status === "created"
                          ? "text-success-ink"
                          : ls.status === "updated"
                            ? "text-accent-ink"
                            : ls.status === "unchanged"
                              ? "text-midnight"
                              : ls.status === "skipped_duplicate"
                                ? "text-warning-ink"
                                : ls.status === "skipped_already_contacted"
                                  ? "text-error-ink"
                                  : ls.status === "rejected_invalid"
                                    ? "text-error-ink"
                                    : "text-error-ink"
                  }`}>
                    {ls.status}
                  </span>
                  <span className={`text-xs text-muted-rose ml-2 ${
                    ls.reason
                      ? "text-error-ink"
                      : "text-midnight-soft"
                  }`}>
                    {ls.reason ?? ""}
                  </span>
                </div>
              ))}
            </div>
            
            <div className="grid grid-cols-6 gap-2">
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Vytvořeno</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "created").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Aktualizováno</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "updated").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Beze změny</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "unchanged").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Duplicitní</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "skipped_duplicate").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Již kontaktováno</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "skipped_already_contacted").length}</span>
              </div>
              <div className="col-span-6 text-center text-xs uppercase text-midnight-strong">
                <span>Chyby</span>
                <span className="font-mono text-midnight">{leadStatuses.filter((l) => l.status === "failed" || l.status === "rejected_invalid").length}</span>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}