"use client";

import { DuplicateNotice } from "@/components/duplicate-notice";
import { QualityGatePanel } from "@/components/quality-gate-panel";
import type { GateEvaluation } from "@/lib/services/outreach-quality-gate";
import type { DuplicateCheckResult } from "@/lib/types";

export interface ComposerValues {
  recipient: string;
  subject: string;
  body: string;
  companyName: string;
  contactName: string;
  messageId: string | null;
  /** Set once the draft is saved, so a send can be recorded against its lead. */
  leadId: string | null;
}

interface EmailComposerProps {
  values: ComposerValues;
  onChange: (patch: Partial<ComposerValues>) => void;
  duplicate: DuplicateCheckResult | null;
  duplicatePending: boolean;
  duplicateError: string | null;
  notice: { kind: "info" | "error"; text: string } | null;
  onClear: () => void;
  onSave: () => void;
  onSend: () => void;
  saving: boolean;
  savingDone: boolean;
  /** Live quality-gate verdict for the draft currently in the composer. */
  gate: GateEvaluation | null;
  gatePending: boolean;
  /** True once the operator has acknowledged the gate's warnings. */
  warningsConfirmed: boolean;
  /** Opens the stored draft in Gmail compose. Never marks anything as sent. */
  onOpenInGmail: () => void;
  openingGmail: boolean;
}

export function EmailComposer(props: EmailComposerProps) {
  const { values, onChange } = props;

  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          <span className="chip chip-solid mr-2 align-middle">2</span>
          Email composer
        </h2>
        <span className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
          ⌘ + S to save draft
        </span>
      </header>

      <div className="space-y-3 p-4">
        <DuplicateNotice
          result={props.duplicate}
          pending={props.duplicatePending}
          error={props.duplicateError}
        />

        <label className="block">
          <span className="field-label">
            Recipient
          </span>
          <input
            type="email"
            value={values.recipient}
            onChange={(event) => onChange({ recipient: event.target.value })}
            spellCheck={false}
            placeholder="info@example.com"
            className="field"
          />
        </label>

        <label className="block">
          <span className="field-label">
            Subject
          </span>
          <input
            type="text"
            value={values.subject}
            onChange={(event) => onChange({ subject: event.target.value })}
            placeholder="AI recepce pro Example"
            className="field"
          />
        </label>

        <label className="block">
          <span className="field-label">
            Body
          </span>
          <textarea
            value={values.body}
            onChange={(event) => onChange({ body: event.target.value })}
            rows={14}
            spellCheck={false}
            className="field resize-y leading-relaxed"
          />
        </label>

        <details className="rounded-[1.25rem] border-[3px] border-dashed border-midnight-line px-4 py-3">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-widest text-midnight-soft">
            Lead details (optional)
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <input
              type="text"
              value={values.companyName}
              onChange={(event) => onChange({ companyName: event.target.value })}
              placeholder="Company name"
              className="field"
            />
            <input
              type="text"
              value={values.contactName}
              onChange={(event) => onChange({ contactName: event.target.value })}
              placeholder="Contact name"
              className="field"
            />
          </div>
        </details>

        {props.notice && (
          <p
            className={props.notice.kind === "error" ? "notice notice-alarm" : "notice"}
          >
            {props.notice.text}
          </p>
        )}

        <QualityGatePanel gate={props.gate} pending={props.gatePending} />

        <div className="flex flex-wrap items-center gap-2 border-t-[3px] border-dashed border-midnight-line pt-5">
          <button
            type="button"
            onClick={props.onSave}
            disabled={props.saving}
            className="btn btn-primary"
          >
            {props.saving ? "Saving…" : props.savingDone ? "Draft saved" : "Save draft"}
          </button>

          {/*
            Opening Gmail only fills a compose window. It is deliberately a
            separate control from "Mark as sent" so the two can never be
            confused: this button records nothing.
          */}
          <button
            type="button"
            onClick={props.onOpenInGmail}
            disabled={props.openingGmail || !values.messageId}
            title={
              values.messageId
                ? "Opens a Gmail draft with this text. This does not send anything and does not mark it as sent."
                : "Save the draft first. Gmail is filled from the saved message, so there is nothing stored to open yet."
            }
            className="btn"
          >
            {props.openingGmail ? "Opening…" : "Open in Gmail ↗"}
          </button>

          {/* The safety rule above is deliberate: the compose text is read from
              the stored message, so an unsaved draft has nothing to open. That
              is invisible on a disabled button, so it is stated here rather than
              left for the operator to work out. */}
          {!values.messageId ? (
            <p className="w-full text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
              Save the draft to enable “Open in Gmail” — it uses the saved text.
            </p>
          ) : null}

          <button
            type="button"
            onClick={props.onSend}
            disabled={props.saving || props.gate?.status === "blocked"}
            title="PEPA does not send email. Send it from your own mail client first, then record it here."
            className="btn"
          >
            {props.saving ? "Recording…" : "Mark as sent"}
          </button>

          <button
            type="button"
            onClick={props.onClear}
            className="rounded-md border border-midnight-line px-3 py-1.5 text-sm font-medium text-midnight transition-colors hover:bg-midnight-faint/40"
          >
            Clear
          </button>

          <p className="w-full pt-1 text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
            Opening Gmail does not mark this as sent — only “Mark as sent” does.
          </p>
        </div>
      </div>
    </section>
  );
}