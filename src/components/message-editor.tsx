"use client";

import { useState, useTransition } from "react";

export interface EditorSaveResult {
  ok: boolean;
  error?: string;
  savedAt?: string;
}

interface MessageEditorProps {
  recipient: string;
  subject: string;
  body: string;
  /** True once the draft already exists server-side. */
  hasSavedDraft: boolean;
  /** Supplied by the caller so one editor serves both deep-link flows. */
  onSave: (values: { subject: string; body: string }) => Promise<EditorSaveResult>;
  saveLabel: string;
}

/**
 * The one composer.
 *
 * Both the follow-up deep link and the ChatGPT import deep link render this,
 * differing only in which server action they pass in. There is deliberately no
 * send control that works: sending arrives with the EmailProvider phase, and
 * until then the operator reviews and sends the email from their own mail
 * client.
 */
export function MessageEditor({
  recipient,
  subject: initialSubject,
  body: initialBody,
  hasSavedDraft,
  onSave,
  saveLabel,
}: MessageEditorProps) {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [editing, setEditing] = useState(!hasSavedDraft);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  function handleSave() {
    setFeedback(null);
    startTransition(async () => {
      const result = await onSave({ subject, body });
      if (result.ok) {
        setFeedback({
          kind: "info",
          text: `Draft saved at ${new Date(result.savedAt ?? Date.now()).toLocaleString("en-GB")}.`,
        });
        setEditing(false);
      } else {
        setFeedback({ kind: "error", text: result.error ?? "The draft could not be saved." });
      }
    });
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
          Recipient
        </span>
        <input
          type="text"
          readOnly
          value={recipient}
          className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-sm text-neutral-600"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
          Subject
        </span>
        <input
          type="text"
          value={subject}
          readOnly={!editing}
          onChange={(event) => setSubject(event.target.value)}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 outline-none read-only:border-neutral-200 read-only:bg-neutral-50 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
          Body
        </span>
        {editing ? (
          <textarea
            value={body}
            rows={14}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Dobrý den,&#10;&#10;návazuji na můj předchozí e-mail…"
            className="w-full resize-y rounded-md border border-neutral-300 p-3 text-sm leading-relaxed text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
          />
        ) : (
          <pre className="w-full overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap text-neutral-800">
            {body || <span className="text-neutral-400">No body yet.</span>}
          </pre>
        )}
      </label>

      {feedback ? (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            feedback.kind === "error"
              ? "border-red-300 bg-red-50 text-red-900"
              : "border-emerald-300 bg-emerald-50 text-emerald-900"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3">
        {editing ? (
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
          >
            {pending ? "Saving…" : saveLabel}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            Edit
          </button>
        )}

        <button
          type="button"
          disabled
          title="Sending arrives with the EmailProvider implementation."
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-400 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}