"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { checkRecipient, saveDraft } from "@/app/actions";
import { EmailComposer, type ComposerValues } from "@/components/email-composer";
import { OutreachHistory } from "@/components/outreach-history";
import { PasteImport } from "@/components/paste-import";
import { NOT_CONFIGURED_MESSAGE } from "@/lib/providers/registry";
import type { DuplicateCheckResult, OutreachHistoryRow, ParsedOutreachInput } from "@/lib/types";

const EMPTY: ComposerValues = {
  recipient: "",
  subject: "",
  body: "",
  companyName: "",
  contactName: "",
  messageId: null,
};

interface Notice {
  kind: "info" | "error";
  text: string;
}

export function Dashboard({ initialRows }: { initialRows: OutreachHistoryRow[] }) {
  const [values, setValues] = useState<ComposerValues>(EMPTY);
  const [hasContent, setHasContent] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateCheckResult | null>(null);
  const [duplicatePending, setDuplicatePending] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);

  const valuesRef = useRef(values);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  const runDuplicateCheck = useCallback(async (recipient: string) => {
    if (!recipient.trim()) {
      setDuplicate(null);
      setDuplicateError(null);
      return;
    }
    setDuplicatePending(true);
    setDuplicateError(null);
    try {
      const result = await checkRecipient(recipient);
      if (result.ok) {
        setDuplicate(result.data);
      } else {
        setDuplicate(null);
        setDuplicateError(result.error);
      }
    } finally {
      setDuplicatePending(false);
    }
  }, []);

  // Re-check whenever the operator edits the recipient, so the warning can
  // never drift from what is stored in Postgres.
  useEffect(() => {
    if (!hasContent) return;
    const handle = setTimeout(() => void runDuplicateCheck(values.recipient), 400);
    return () => clearTimeout(handle);
  }, [values.recipient, hasContent, runDuplicateCheck]);

  function handleParsed(parsed: ParsedOutreachInput) {
    setValues((current) => ({
      ...current,
      recipient: parsed.recipient || current.recipient,
      subject: parsed.subject || current.subject,
      body: parsed.body || current.body,
    }));
    setHasContent(true);
    setSaved(false);
    setDuplicateError(
      parsed.warnings.join(" ") ||
        (parsed.missing.length ? `Missing: ${parsed.missing.join(", ")}` : null),
    );
    void runDuplicateCheck(parsed.recipient);
  }

  function handleClear() {
    setValues(EMPTY);
    setHasContent(false);
    setDuplicate(null);
    setDuplicateError(null);
    setNotice(null);
    setSaved(false);
    setFocusSignal((n) => n + 1);
  }

  async function handleSave() {
    setSaving(true);
    setNotice(null);
    try {
      const result = await saveDraft({
        recipientEmail: values.recipient,
        subject: values.subject,
        body: values.body,
        companyName: values.companyName || null,
        contactName: values.contactName || null,
        messageId: values.messageId,
      });

      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }

      setValues((current) => ({
        ...current,
        messageId: result.message.id,
        companyName: result.lead.company_name ?? current.companyName,
        contactName: result.lead.contact_name ?? current.contactName,
      }));
      setSaved(true);
      setNotice({ kind: "info", text: `Draft saved for ${result.lead.email}.` });
      void runDuplicateCheck(result.lead.email);
      setFocusSignal((n) => n + 1);
    } finally {
      setSaving(false);
    }
  }

  function handleSend() {
    setNotice({ kind: "info", text: NOT_CONFIGURED_MESSAGE });
  }

  function handleOpenFromHistory(row: OutreachHistoryRow) {
    setValues({
      recipient: row.email,
      subject: row.latestSubject ?? "",
      body: "",
      companyName: row.company_name ?? "",
      contactName: row.contact_name ?? "",
      messageId: null,
    });
    setHasContent(true);
    setSaved(false);
    void runDuplicateCheck(row.email);
    window.scrollTo({ top: 0 });
  }

  // Global shortcuts: ⌘S save draft, ⌘K clear, ⌘/ focus the paste box.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (valuesRef.current.recipient) void handleSave();
      } else if (key === "k") {
        event.preventDefault();
        handleClear();
      } else if (key === "/") {
        event.preventDefault();
        setFocusSignal((n) => n + 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-7">
      <PasteImport
        onParsed={handleParsed}
        onError={(message) => {
          setDuplicateError(null);
          setNotice({ kind: "error", text: message });
        }}
        focusSignal={focusSignal}
        disabled={false}
      />

      {hasContent ? (
        <EmailComposer
          values={values}
          onChange={(patch) => {
            setValues((current) => ({ ...current, ...patch }));
            setSaved(false);
          }}
          duplicate={duplicate}
          duplicatePending={duplicatePending}
          duplicateError={duplicateError}
          notice={notice}
          onClear={handleClear}
          onSave={() => void handleSave()}
          onSend={handleSend}
          saving={saving}
          savingDone={saved}
        />
      ) : null}

      <OutreachHistory rows={initialRows} onLoadIntoComposer={handleOpenFromHistory} />
    </div>
  );
}