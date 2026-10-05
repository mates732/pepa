"use client";

import { useCallback, useEffect, useState } from "react";

import { importBulkEmails, previewBulkEmails } from "@/app/bulk-actions";
import { BulkPreviewTable, BulkSummary } from "@/components/bulk-preview-table";
import {
  BULK_IMPORT_CHUNK_SIZE,
  importableRequests,
  summarizeOutcomes,
  type BulkDraftRequest,
  type BulkDraftResultRow,
  type BulkEmailPlan,
} from "@/lib/import/bulk-plan";

/**
 * Paste Emails — paste finished outreach emails, preview them, create drafts.
 *
 * WHY IT LOOKS LIKE THIS. It is the same bar-and-dialog shape as `PasteImport`,
 * reusing `sticker`, `btn`, `chip` and the dialog markup, because two dialogs
 * that behave differently is a worse experience than one dialog that does more.
 *
 * THE WORKFLOW, and what it deliberately does NOT contain:
 *
 *     PASTE → PARSE → PREVIEW → IMPORT → REVIEW → USER SENDS
 *
 * There is no generate, no analyze and no send-all. The emails are already
 * written and this feature does not touch a word of them. All it does is create
 * ordinary Pepa drafts, which then appear in the history table and are composed,
 * sent and recorded through exactly the existing per-draft flow — including the
 * quality gate and the historical hard stop, which are untouched here.
 *
 * Import runs in chunks so the UI can report progress that means something and
 * so a failed chunk can be retried without redoing the paste. Rows are
 * re-checked server-side regardless, so a retry cannot create a second draft.
 */

export type BulkPanel = "closed" | "open";
export type BulkPanelAction = "open" | "close" | "toggle";

export function nextBulkPanel(current: BulkPanel, action: BulkPanelAction): BulkPanel {
  if (action === "open") return "open";
  if (action === "close") return "closed";
  return current === "open" ? "closed" : "open";
}

/** Where the dialog is in the workflow. Advanced one step at a time, never back. */
export type BulkStage = "paste" | "preview" | "imported";

/**
 * The next stage after an action.
 *
 * A pure function so "import is unreachable from the paste screen" is an
 * assertion rather than a hope — the dialog can only advance, never skip the
 * preview.
 */
export function nextBulkStage(current: BulkStage, action: "previewed" | "imported"): BulkStage {
  if (current === "paste") return action === "previewed" ? "preview" : current;
  return action === "imported" ? "imported" : current;
}

/** Progress while chunks are in flight. */
export interface BulkProgress {
  done: number;
  total: number;
}

/**
 * Walk the chunk list one request at a time.
 *
 * Sequential by design: the chunks exist to give the operator progress and a
 * retry boundary, and eight parallel chunk requests would put the whole paste
 * back behind a single latency. Concurrency lives INSIDE a chunk instead, where
 * `importBulkEmails` bounds it.
 *
 * A chunk that fails outright does not abandon the rest of the paste — its rows
 * are recorded as failed and the walk continues, which is what makes a partial
 * import recoverable instead of all-or-nothing.
 */
export async function importInChunks(
  requests: BulkDraftRequest[],
  onProgress: (progress: BulkProgress) => void,
  chunkSize: number = BULK_IMPORT_CHUNK_SIZE,
): Promise<BulkDraftResultRow[]> {
  const collected: BulkDraftResultRow[] = [];

  for (let start = 0; start < requests.length; start += chunkSize) {
    const chunk = requests.slice(start, start + chunkSize);
    const result = await importBulkEmails(chunk);

    if (result.ok) {
      collected.push(...result.rows);
    } else {
      // The whole chunk failed. Record every row so the totals still add up and
      // the retry list is complete.
      for (const row of chunk) {
        collected.push({
          index: row.index,
          recipient: row.recipient,
          outcome: "failed",
          messageId: null,
          leadId: null,
          error: result.error,
        });
      }
    }

    onProgress({ done: Math.min(start + chunkSize, requests.length), total: requests.length });
  }

  return collected;
}

export interface BulkImportProps {
  /** Reported when drafts were created, so the caller can refresh its views. */
  onImported?: (result: { created: number; existing: number; skipped: number }) => void;
}

const EXAMPLE = `To: info@bella.cz
Subject: Váš web
Dobrý den,

rád bych vám ukázal, jak lze zlepšit váš web.

S pozdravem
Petr

---

To: barber@barberx.cz
Subject: AI recepce
Dobrý den,

nabízím AI recepci pro vaši provozovnu.

S pozdravem
Petr`;

export function BulkImport({ onImported }: BulkImportProps) {
  const [panel, setPanel] = useState<BulkPanel>("closed");
  const [stage, setStage] = useState<BulkStage>("paste");
  const [value, setValue] = useState("");
  const [plan, setPlan] = useState<BulkEmailPlan | null>(null);
  const [results, setResults] = useState<BulkDraftResultRow[] | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    setPanel((current) => nextBulkPanel(current, "close"));
  }, []);

  // Escape closes, as a dialog is expected to.
  useEffect(() => {
    if (panel !== "open") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel, close]);

  async function handlePreview() {
    if (!value.trim()) {
      setError("Nothing to parse — paste your finished emails first.");
      return;
    }

    setChecking(true);
    setError(null);
    try {
      const result = await previewBulkEmails(value);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPlan(result.plan);
      setStage((current) => nextBulkStage(current, "previewed"));
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Could not read the pasted emails.");
    } finally {
      setChecking(false);
    }
  }

  /**
   * Create drafts only for what the plan marked ready, then report.
   *
   * `plan` is the input to the request, not its authority: the server re-checks
   * every row, so a plan that went stale between preview and import cannot turn
   * into a draft for a historically contacted address.
   */
  async function handleImport() {
    if (!plan) return;

    const requests = importableRequests(plan);
    if (requests.length === 0) {
      setError("Nothing ready to import in this paste.");
      return;
    }

    setImporting(true);
    setError(null);
    try {
      const rows = await importInChunks(requests, setProgress);
      setResults(rows);
      setStage((current) => nextBulkStage(current, "imported"));

      const totals = summarizeOutcomes(rows);
      onImported?.({ created: totals.ready, existing: totals.alreadyPresent, skipped: totals.skipped });
      if (totals.failed > 0) {
        setError(
          `${totals.failed} email(s) could not be saved. The rest were saved — retry just those.`,
        );
      }
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  /**
   * Re-send only the rows that failed.
   *
   * The retry re-reads the plan for the text, because the failed result row does
   * not carry the body — and the body must be the operator's own words, not
   * anything reconstructed here. `createDraft` upserts, so no duplicates.
   */
  async function handleRetry() {
    if (!results || !plan) return;

    const byIndex = new Map(plan.rows.map((row) => [row.index, row]));
    const retry: BulkDraftRequest[] = results
      .filter((row) => row.outcome === "failed")
      .map((row) => {
        const source = byIndex.get(row.index);
        return {
          index: row.index,
          recipient: source?.recipient ?? row.recipient,
          subject: source?.subject ?? null,
          body: source?.body ?? null,
        };
      })
      .filter((row): row is BulkDraftRequest => Boolean(row.recipient));

    if (retry.length === 0) return;

    setImporting(true);
    setError(null);
    try {
      const rows = await importInChunks(retry, setProgress);
      setResults((current) =>
        (current ?? []).map((row) => {
          const replacement = rows.find((retryRow) => retryRow.index === row.index);
          return replacement && replacement.outcome !== "failed" ? replacement : row;
        }),
      );
      const totals = summarizeOutcomes(rows);
      onImported?.({ created: totals.ready, existing: totals.alreadyPresent, skipped: totals.skipped });
      if (totals.failed > 0) {
        setError(`${totals.failed} email(s) still failing. Check the address and retry.`);
      }
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Retry failed.");
    } finally {
      setImporting(false);
    }
  }

  const totals = results ? summarizeOutcomes(results) : null;
  const open = panel === "open";

  return (
    <>
      <section className="sticker">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <h2 className="heading-sticker text-base text-midnight">
            <span className="chip chip-solid mr-2 align-middle">1b</span>
            Paste Emails
          </h2>

          <button
            type="button"
            onClick={() => setPanel((current) => nextBulkPanel(current, "toggle"))}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="btn btn-primary"
          >
            + Paste Emails
          </button>
        </div>
      </section>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-midnight/40 px-4 py-8">
          <div className="absolute inset-0" onClick={close} aria-hidden />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Paste finished emails"
            className="sticker relative w-full max-w-4xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
              <h3 className="heading-sticker text-base text-midnight">Paste finished emails</h3>
              <button type="button" onClick={close} className="btn btn-sm" aria-label="Close">
                Close
              </button>
            </header>

            <div className="p-5">
              <label htmlFor="bulk-emails-input" className="field-label">
                Finished emails — separated by <code className="font-mono">---</code> or a blank line
              </label>
              <textarea
                id="bulk-emails-input"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handlePreview();
                  }
                }}
                rows={10}
                spellCheck={false}
                placeholder={EXAMPLE}
                className="field resize-y font-mono text-[13px] leading-relaxed"
              />

              <p className="mt-2 text-[11px] text-midnight-soft">
                Your text is used exactly as written. Pepa only reads the recipient, subject and
                body — it never rewrites, personalizes or generates anything.
              </p>

              {error ? <div className="notice notice-alarm mt-4">{error}</div> : null}

              {stage === "paste" ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void handlePreview()}
                    disabled={checking}
                    className="btn btn-primary"
                  >
                    {checking ? "Checking…" : "Preview emails"}
                  </button>
                  <button type="button" onClick={() => setValue("")} className="btn">
                    Clear
                  </button>
                  <button type="button" onClick={close} className="btn">
                    Cancel
                  </button>
                </div>
              ) : null}

              {plan ? (
                <>
                  <div className="mt-5">
                    <BulkSummary summary={plan.summary} splitBy={plan.splitBy} />
                  </div>

                  <BulkPreviewTable rows={plan.rows} />

                  {stage === "preview" ? (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void handleImport()}
                        disabled={importing || plan.summary.importable === 0}
                        className="btn btn-primary"
                      >
                        {importing
                          ? "Saving…"
                          : `Create ${plan.summary.importable} draft${
                              plan.summary.importable === 1 ? "" : "s"
                            }`}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPlan(null);
                          setStage("paste");
                        }}
                        className="btn"
                        disabled={importing}
                      >
                        Back
                      </button>
                      <button type="button" onClick={close} className="btn" disabled={importing}>
                        Cancel
                      </button>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
                        Drafts only · you send every email yourself
                      </p>
                    </div>
                  ) : null}

                  {progress && importing ? (
                    <div className="mt-4" aria-live="polite">
                      <p className="text-xs font-bold uppercase tracking-wider text-midnight-soft">
                        Saving drafts… {progress.done} / {progress.total}
                      </p>
                      <div className="mt-1 h-3 w-full rounded-full border-2 border-midnight bg-paper">
                        <div
                          className="h-full bg-midnight"
                          style={{
                            width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}

              {stage === "imported" && totals ? (
                <div className="mt-5 rounded-[1.25rem] border-[3px] border-midnight px-4 py-3">
                  <p className="text-sm font-black uppercase tracking-wide text-midnight">
                    {totals.succeeded} draft{totals.succeeded === 1 ? "" : "s"} ready
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wider">
                    <span className="rounded-full border-2 border-midnight bg-midnight-faint px-2 py-0.5 text-midnight">
                      {totals.ready} created
                    </span>
                    <span className="rounded-full border-2 border-midnight bg-midnight/15 px-2 py-0.5 text-midnight">
                      {totals.alreadyPresent} already existed
                    </span>
                    <span className="rounded-full border-2 border-midnight bg-midnight/35 px-2 py-0.5 text-midnight">
                      {totals.skipped} skipped
                    </span>
                    {totals.failed > 0 ? (
                      <span className="rounded-full border-2 border-midnight bg-midnight/65 px-2 py-0.5 text-cream">
                        {totals.failed} failed
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-midnight-soft">
                    Each draft is separate and holds your text unchanged. Open any of them from the
                    composer or the history table — Pepa did not send anything.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {totals.failed > 0 ? (
                      <button
                        type="button"
                        onClick={() => void handleRetry()}
                        disabled={importing}
                        className="btn"
                      >
                        {importing ? "Retrying…" : `Retry ${totals.failed} failed`}
                      </button>
                    ) : null}
                    <button type="button" onClick={close} className="btn btn-primary">
                      Done
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}