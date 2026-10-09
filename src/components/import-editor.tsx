"use client";

import { GmailComposeButton } from "@/components/gmail-compose-button";
import { MessageEditor, type EditorSaveResult } from "@/components/message-editor";
import { saveImport } from "@/app/import-actions";

interface ImportEditorProps {
  token: string;
  recipient: string;
  subject: string;
  body: string;
}

/**
 * Composer for a ChatGPT-imported draft. Same editor, import save action.
 *
 * Plus the last hop of the ChatGPT → PEPA → Gmail chain: an "Open in Gmail"
 * button, so the operator who followed an "Open in PEPA" link from a ChatGPT
 * conversation lands on the exact prepared draft and can reach Gmail in one
 * click, instead of having to save the draft and then go hunting for it in
 * Outreach history.
 *
 * Two things this deliberately does not do:
 *
 *   * It does not pass any content to Gmail. The compose URL is built from the
 *     draft data already on this page, so the text Gmail receives is exactly
 *     what PEPA stored and nothing on this page can influence it.
 *   * It does not send. The button opens a compose window; the operator presses
 *     Send in Gmail, and that stays the only step that sends an email.
 */
export function ImportEditor({ token, recipient, subject, body }: ImportEditorProps) {
  async function onSave(values: { subject: string; body: string }): Promise<EditorSaveResult> {
    const result = await saveImport({ token, subject: values.subject, body: values.body });
    return result.ok ? { ok: true, savedAt: result.savedAt } : { ok: false, error: result.error };
  }

  return (
    <div className="space-y-4">
      <MessageEditor
        recipient={recipient}
        subject={subject}
        body={body}
        hasSavedDraft={true}
        onSave={onSave}
        saveLabel="Save imported draft"
      />

      <div className="space-y-2 border-t-[3px] border-dashed border-midnight-line pt-5">
        <GmailComposeButton input={{ to: recipient, subject, body }} />

        {/* The button fills from the SAVED draft, exactly like the dashboard
            composer. Saying so prevents the one genuinely surprising case: the
            operator edits the text, forgets to save, and gets the previous text
            in Gmail. */}
        <p className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
          &ldquo;Open in Gmail&rdquo; fills from the saved draft — save your edits first. You still press
          Send in Gmail yourself.
        </p>
      </div>
    </div>
  );
}