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
        <span className="field-label">
          Recipient
        </span>
        <input
          type="text"
          readOnly
          value={recipient}
          className="field cursor-not-allowed bg-midnight-faint/50 font-mono text-midnight-soft"
        />
      </label>

      <label className="block">
        <span className="field-label">
          Subject
        </span>
        <input
          type="text"
          value={subject}
          readOnly={!editing}
          onChange={(event) => setSubject(event.target.value)}
          className="field read-only:cursor-not-allowed read-only:bg-midnight-faint/50 read-only:text-midnight-soft"
        />
      </label>

      <label className="block">
        <span className="field-label">
          Body
        </span>
        {editing ? (
          <textarea
            value={body}
            rows={14}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Dobrý den,&#10;&#10;návazuji na můj předchozí e-mail…"
            className="field resize-y leading-relaxed"
          />
        ) : (
          <pre className="field overflow-x-auto bg-midnight-faint/40 leading-relaxed whitespace-pre-wrap">
            {body || <span className="text-midnight-soft/60">No body yet.</span>}
          </pre>
        )}
      </label>

      {feedback ? (
        <p
          role="status"
          className={feedback.kind === "error" ? "notice notice-alarm" : "notice"}
        >
          {feedback.text}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t-[3px] border-dashed border-midnight-line pt-5">
        {editing ? (
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="btn btn-primary"
          >
            {pending ? "Saving…" : saveLabel}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-midnight-line px-3 py-1.5 text-sm font-medium text-midnight transition-colors hover:bg-midnight-faint/40"
          >
            Edit
          </button>
        )}

        <button
          type="button"
          disabled
          title="Sending arrives with the EmailProvider implementation."
          className="btn disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}