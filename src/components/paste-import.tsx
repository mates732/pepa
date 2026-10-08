"use client";

import { useEffect, useRef, useState } from "react";

import { isLeadMarker } from "@/lib/import/bulk-emails";
import { parseBulkEmails } from "@/lib/import/bulk-emails";
import type { BulkEmailCandidate } from "@/lib/import/bulk-emails";

/**
 * Paste / Import — a compact bar that opens a paste dialog.
 *
 * WHY THIS SHAPE. The textarea used to sit permanently open as the tallest
 * element on the dashboard, pushing every workspace below the fold to make room
 * for an input that is used a handful of times a day. It is now a one-line bar;
 * the actual paste surface lives in a dialog and is only mounted when the
 * operator asks for it. Nothing about the import itself changed: the same
 * `parseOutreachInput` runs, the same validation runs, and `onParsed` still
 * reports the same shape. Only the chrome moved.
 *
 * The panel state is a tiny explicit machine rather than scattered booleans, so
 * "the textarea is not in the document until the bar is opened" is a property
 * that can be asserted directly.
 */

interface PasteImportProps {
  onParsed: (parsed: BulkEmailCandidate, raw: string) => void;
  onError: (message: string) => void;

  focusSignal: number;
  disabled: boolean;
}

export type PastePanel = "closed" | "open";
export type PastePanelAction = "open" | "close" | "toggle";

/**
 * The whole state machine. `closed` is the initial state, which is what keeps
 * the large textarea out of the document by default.
 */
export function nextPastePanel(
  current: PastePanel,
  action: PastePanelAction,
): PastePanel {
  if (action === "open") return "open";
  if (action === "close") return "closed";
  return current === "open" ? "closed" : "open";
}

/** Props shared by the bar and the dialog, so the parse logic lives in one place. */
interface PasteBodyProps extends PasteImportProps {
  value: string;
  setValue: (next: string) => void;
  onClose: () => void;
}

/**
 * The single-lead bar's verdict — one candidate, or the reason to refuse.
 */

/**
 * Narrow the ONE canonical parser to the single-lead context.
 *
 * Every paste — this bar's and the bulk dialog's — is read by
 * `parseBulkEmails()`. This wrapper only decides what the single-lead dialog
 * does with the answer:
 *
 *   0 candidates  → nothing to parse;
 *   1 candidate   → hand it to the composer (the ONLY accepted outcome);
 *   2+ candidates → refuse and point at "Paste Emails" (bar 1b), because a
 *                   single-lead dialog must never merge a batch — the failure
 *                   mode that produced one composer with both recipients
 *                   space-joined. The batch stays intact in the bulk flow,
 *                   where each lead gets its own row, draft and sequences.
 *
 * Exported so tests can prove this path and the bulk path return the SAME
 * candidate for the same input — one parser, one grammar, one data model.
 */
export function singleLeadFromPaste(raw: string): SingleLeadParse {
  if (!raw.trim()) {
    return {
      ok: false,
      error: "Nothing to parse — paste the recipient, subject and body first.",
    };
  }

  const { candidates } = parseBulkEmails(raw);

  if (candidates.length === 0) {
    return {
      ok: false,
      error: "Nothing to parse — paste the recipient, subject and body first.",
    };
  }

  if (candidates.length > 1) {
    return {
      ok: false,
      error:
        `This input contains ${candidates.length} lead${candidates.length === 1 ? "" : "s"}, not one. Use “Paste Emails” (bar 1b) ` +
        "to preview and import them separately — each lead keeps its own recipient, subject " +
        "and follow-ups, and nothing is merged.",
    };
  }

  const candidate = candidates[0]!;

  // A LEAD block with no subject or body is an incomplete batch entry —
  // it belongs in the bulk dialog, not the single-lead bar.
  if (
    raw.split("\n").some((line) => isLeadMarker(line)) &&
    (candidate.subject === null || candidate.body === null)
  ) {
    return {
      ok: false,
      error:
        `This input contains 1 lead, not one. Use “Paste Emails” (bar 1b) ` +
        "to preview and import them separately — nothing is merged.",
    };
  }

  return { ok: true, candidate };
}
/** The single-lead bar's verdict — one candidate, or the reason to refuse. */
export type SingleLeadParse =
  { ok: true; candidate: BulkEmailCandidate } | { ok: false; error: string };
/**
 * Parse the paste and return the single-lead verdict, the same wrapper the
 * dialog uses.
 */

/**
 * The reported production bug: a `--- LEAD NN ---` batch pasted into the single-lead dialog
 * would have produced one composer with both recipients space-joined, both
 * subjects concatenated, and the raw metadata plus `Follow-up …` labels as
 * the body. The guard now runs against the canonical parser: any input whose
 * block count is not exactly one is refused before it ever reaches the composer.
 */
export function batchPasteHint(raw: string): string | null {
  if (!raw.trim()) return null;

  const { candidates } = parseBulkEmails(raw);

  if (candidates.length > 1) {
    return `This input contains ${candidates.length} \`--- LEAD ---\` markers. Use “Paste Emails” (bar 1b) to preview and import them separately — nothing is merged.`;
  }

  const markers = raw.split("\n").filter((line) => isLeadMarker(line)).length;
  if (markers > 0) {
    return `This input contains ${markers} \`--- LEAD ---\` marker${markers > 1 ? "s" : ""}. Use “Paste Emails” (bar 1b) to preview and import them separately — nothing is merged.`;
  }

  return null;
}

/** The compact bar — opens the paste dialog on toggle. */

/** Shared body of the bar and the dialog. */
function PasteBody({
  value,
  setValue,
  onClose,
  onParsed,
  onError,
  disabled,
}: PasteBodyProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleParse() {
    // ONE parser: the same `parseBulkEmails()` the bulk dialog runs. This
    // wrapper only enforces the single-lead contract — exactly one candidate
    // with a recipient, or a refusal that never reaches the composer.
    const result = singleLeadFromPaste(value);
    if (!result.ok) {
      onError(result.error);
      textareaRef.current?.focus();
      return;
    }
    onParsed(result.candidate, value);
  }

  return (
    <div className="p-5">
      <label htmlFor="paste-lead-input" className="field-label">
        Recipient, subject, body
      </label>
      <textarea
        id="paste-lead-input"
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            handleParse();
          }
        }}
        disabled={disabled}
        rows={11}
        spellCheck={false}
        placeholder="recipient: info@example.com\nsubject: AI recepce pro Example\nbody: Dobrý den,\n\nchtěl jsem Vám ukázat..."
        className="field resize-y font-mono text-[13px] leading-relaxed"
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleParse}
          disabled={disabled}
          className="btn btn-primary"
        >
          Import
        </button>
        <button
          type="button"
          onClick={() => setValue("")}
          className="btn"
          disabled={disabled}
        >
          Clear
        </button>
        <button type="button" onClick={onClose} className="btn">
          Cancel
        </button>
      </div>

      <p className="mt-3 text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
        ⌘ + ↵ to import · nothing is sent
      </p>
    </div>
  );
}
export function PasteImport(props: PasteImportProps) {
  const [panel, setPanel] = useState<PastePanel>("closed");
  const [value, setValue] = useState("");

  // The ⌘ / shortcut used to focus a textarea that was always on the page. It now
  // opens the dialog, which is what focusing a hidden field can no longer do.
  //
  // Handled as a derived-state adjustment during render rather than in an
  // effect: mirroring a prop into state in an effect is an extra render pass,
  // and it is the pattern that goes stale when two updates land together.
  const [lastFocusSignal, setLastFocusSignal] = useState(props.focusSignal);
  if (props.focusSignal !== lastFocusSignal) {
    setLastFocusSignal(props.focusSignal);
    setPanel((current) => nextPastePanel(current, "open"));
  }

  const close = () => setPanel((current) => nextPastePanel(current, "close"));

  // Escape closes, the way a dialog is expected to behave.
  useEffect(() => {
    if (panel !== "open") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panel]);

  const open = panel === "open";

  return (
    <>
      <section className="sticker">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <h2 className="heading-sticker text-base text-midnight">
            <span className="chip chip-solid mr-2 align-middle">1</span>
            Paste / Import
          </h2>

          <button
            type="button"
            onClick={() =>
              setPanel((current) => nextPastePanel(current, "toggle"))
            }
            disabled={props.disabled}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="btn btn-primary"
          >
            Paste lead +
          </button>
        </div>
      </section>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-midnight/40 px-4 py-8">
          {/* Backdrop click closes; the panel stops propagation so a click inside
              cannot dismiss the dialog the operator is typing in. */}
          <div className="absolute inset-0" onClick={close} aria-hidden />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Paste lead"
            className="sticker relative w-full max-w-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
              <h3 className="heading-sticker text-base text-midnight">
                Paste lead
              </h3>
              <button
                type="button"
                onClick={close}
                className="btn btn-sm"
                aria-label="Close"
              >
                Close
              </button>
            </header>

            <PasteBody
              {...props}
              value={value}
              setValue={setValue}
              onClose={close}
            />
          </section>
        </div>
      ) : null}
    </>
  );
}
