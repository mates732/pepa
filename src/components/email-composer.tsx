"use client";

import { DuplicateNotice } from "@/components/duplicate-notice";
import { NOT_CONFIGURED_MESSAGE } from "@/lib/providers/registry";
import type { DuplicateCheckResult } from "@/lib/types";

export interface ComposerValues {
  recipient: string;
  subject: string;
  body: string;
  companyName: string;
  contactName: string;
  messageId: string | null;
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
}

export function EmailComposer(props: EmailComposerProps) {
  const { values, onChange } = props;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white shadow-sm">
      <header className="flex items-baseline justify-between border-b border-neutral-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-900">2 · Email composer</h2>
        <span className="text-xs text-neutral-500">
          <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-sans text-[11px]">
            ⌘
          </kbd>
          <span className="mx-0.5">+</span>
          <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-sans text-[11px]">
            S
          </kbd>{" "}
          to save draft
        </span>
      </header>

      <div className="space-y-3 p-4">
        <DuplicateNotice
          result={props.duplicate}
          pending={props.duplicatePending}
          error={props.duplicateError}
        />

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
            Recipient
          </span>
          <input
            type="email"
            value={values.recipient}
            onChange={(event) => onChange({ recipient: event.target.value })}
            spellCheck={false}
            placeholder="info@example.com"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
            Subject
          </span>
          <input
            type="text"
            value={values.subject}
            onChange={(event) => onChange({ subject: event.target.value })}
            placeholder="AI recepce pro Example"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
            Body
          </span>
          <textarea
            value={values.body}
            onChange={(event) => onChange({ body: event.target.value })}
            rows={14}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-neutral-300 p-3 text-sm leading-relaxed text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
          />
        </label>

        <details className="rounded-md border border-dashed border-neutral-300 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-neutral-500">
            Lead details (optional)
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <input
              type="text"
              value={values.companyName}
              onChange={(event) => onChange({ companyName: event.target.value })}
              placeholder="Company name"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
            />
            <input
              type="text"
              value={values.contactName}
              onChange={(event) => onChange({ contactName: event.target.value })}
              placeholder="Contact name"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
            />
          </div>
        </details>

        {props.notice && (
          <p
            className={`rounded-md border px-3 py-2 text-sm ${
              props.notice.kind === "error"
                ? "border-red-300 bg-red-50 text-red-900"
                : "border-emerald-300 bg-emerald-50 text-emerald-900"
            }`}
          >
            {props.notice.text}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3">
          <button
            type="button"
            onClick={props.onSave}
            disabled={props.saving}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
          >
            {props.saving ? "Saving…" : props.savingDone ? "Draft saved" : "Save draft"}
          </button>

          <button
            type="button"
            onClick={props.onSend}
            disabled={props.saving}
            title={NOT_CONFIGURED_MESSAGE}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
          >
            Send
          </button>

          <button
            type="button"
            onClick={props.onClear}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            Clear
          </button>
        </div>
      </div>
    </section>
  );
}