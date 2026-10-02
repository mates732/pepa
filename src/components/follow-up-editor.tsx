"use client";

import { saveFollowUp } from "@/app/followup-actions";
import { MessageEditor, type EditorSaveResult } from "@/components/message-editor";

interface FollowUpEditorProps {
  token: string;
  recipient: string;
  subject: string;
  body: string;
  savedMessageId: string | null;
}

/**
 * Follow-up deep link composer.
 *
 * A thin wrapper over the shared `MessageEditor`: the follow-up page owns the
 * follow-up token, the import page owns the import token, and neither has to
 * know how the other's save action works.
 */
export function FollowUpEditor({
  token,
  recipient,
  subject,
  body,
  savedMessageId,
}: FollowUpEditorProps) {
  async function onSave(values: { subject: string; body: string }): Promise<EditorSaveResult> {
    const result = await saveFollowUp({ token, subject: values.subject, body: values.body });
    return result.ok
      ? { ok: true, savedAt: result.savedAt }
      : { ok: false, error: result.error };
  }

  return (
    <MessageEditor
      recipient={recipient}
      subject={subject}
      body={body}
      hasSavedDraft={Boolean(savedMessageId)}
      onSave={onSave}
      saveLabel="Save"
    />
  );
}