"use client";

import { saveImport } from "@/app/import-actions";
import { MessageEditor, type EditorSaveResult } from "@/components/message-editor";

interface ImportEditorProps {
  token: string;
  recipient: string;
  subject: string;
  body: string;
}

/** Composer for a ChatGPT-imported draft. Same editor, import save action. */
export function ImportEditor({ token, recipient, subject, body }: ImportEditorProps) {
  async function onSave(values: { subject: string; body: string }): Promise<EditorSaveResult> {
    const result = await saveImport({ token, subject: values.subject, body: values.body });
    return result.ok ? { ok: true, savedAt: result.savedAt } : { ok: false, error: result.error };
  }

  return (
    <MessageEditor
      recipient={recipient}
      subject={subject}
      body={body}
      hasSavedDraft={true}
      onSave={onSave}
      saveLabel="Save imported draft"
    />
  );
}