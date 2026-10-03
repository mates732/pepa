"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { checkQualityGate, checkRecipient, recordOutreachSent, saveDraft } from "@/app/actions";
import { EmailComposer, type ComposerValues } from "@/components/email-composer";
import { OutreachHistory } from "@/components/outreach-history";
import { PasteImport } from "@/components/paste-import";
import { formatDate, formatDateTime } from "@/lib/format";
import type { GateEvaluation } from "@/lib/services/outreach-quality-gate";
import type { DuplicateCheckResult, OutreachHistoryRow, ParsedOutreachInput } from "@/lib/types";

const EMPTY: ComposerValues = {
  recipient: "",
  subject: "",
  body: "",
  companyName: "",
  contactName: "",
  messageId: null,
  leadId: null,
};

/**
 * Spoken before anything is written.
 *
 * PEPA does not send email and has no provider. The operator sends it from their
 * own mail client first; this only records the fact. The wording has to say so
 * before the click, not after.
 */
const SENT_CONFIRMATION =
  "PEPA does not send this email. Confirm only after you have sent it through your email provider.";

/** Second gate, shown only when the quality gate raised warnings. */
const WARNING_CONFIRMATION =
  "The quality gate raised warnings. Record it as sent anyway only if you have checked them yourself.";

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
  const [gate, setGate] = useState<GateEvaluation | null>(null);
  const [gatePending, setGatePending] = useState(false);
  // Set once the operator has answered the warning confirmation, so the retry
  // is an explicit decision rather than a silent override.
  const [warningsConfirmed, setWarningsConfirmed] = useState(false);

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

  const runGateCheck = useCallback(async () => {
    setGatePending(true);
    try {
      const result = await checkQualityGate({
        recipient: valuesRef.current.recipient,
        subject: valuesRef.current.subject,
        body: valuesRef.current.body,
        messageId: valuesRef.current.messageId,
        leadId: valuesRef.current.leadId,
      });
      // A failed evaluation must not leave a stale verdict on screen.
      if (result.ok) {
        setGate(result.gate);
      } else {
        setGate(null);
      }
    } finally {
      setGatePending(false);
    }
  }, []);

  // Re-check whenever the operator edits the recipient, so the warning can
  // never drift from what is stored in Postgres.
  useEffect(() => {
    if (!hasContent) return;
    const handle = setTimeout(() => void runDuplicateCheck(values.recipient), 400);
    return () => clearTimeout(handle);
  }, [values.recipient, hasContent, runDuplicateCheck]);

  // The gate depends on subject and body too, so it gets its own debounce.
  // Advisory only: the server re-runs every check at the moment of the send.
  useEffect(() => {
    if (!hasContent) return;
    const handle = setTimeout(() => void runGateCheck(), 500);
    return () => clearTimeout(handle);
  }, [
    values.recipient,
    values.subject,
    values.body,
    values.messageId,
    values.leadId,
    hasContent,
    runGateCheck,
  ]);

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
    setGate(null);
    setWarningsConfirmed(false);
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
        leadId: result.lead.id,
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

  /**
   * Record an already-sent draft. This does NOT send anything.
   *
   * Confirmation is required first, then the server action compare-and-sets the
   * row and schedules follow-up #1. Submitting twice is safe: the second call
   * comes back `already_sent` and schedules nothing further.
   */
  async function handleSend() {
    if (!values.messageId || !values.leadId) {
      setNotice({
        kind: "error",
        text: "Save the draft first — there is nothing recorded to mark as sent yet.",
      });
      return;
    }

    // A warning the operator has already reviewed does not ask twice; one they
    // have not gets its own explicit confirmation before anything is recorded.
    if (!warningsConfirmed && gate?.status === "warning") {
      if (!window.confirm(WARNING_CONFIRMATION)) return;
      setWarningsConfirmed(true);
    }

    if (!window.confirm(SENT_CONFIRMATION)) return;

    setSaving(true);
    setNotice(null);
    try {
      const result = await recordOutreachSent({
        messageId: values.messageId,
        leadId: values.leadId,
        confirmWarnings: warningsConfirmed,
      });

      if (!result.ok) {
        // The server is authoritative: it re-runs the gate and can refuse even
        // when the composer looked acceptable.
        // ActionFailure has no `outcome` and no `gate`; a generic failure is
        // just an error string.
        const refusal = "outcome" in result ? result : null;
        if (refusal?.gate) setGate(refusal.gate);
        setNotice({
          kind: "error",
          text:
            refusal?.outcome === "needs_confirmation"
              ? `${result.error} Confirm the warnings to continue.`
              : result.error,
        });
        return;
      }

      setSaved(true);

      if (result.outcome === "already_sent") {
        setNotice({
          kind: "info",
          text: `Already recorded as sent on ${formatDateTime(
            result.message.sent_at,
          )}. Nothing was changed.`,
        });
      } else if (result.nextFollowUpAt) {
        setNotice({
          kind: "info",
          text: `Recorded as sent at ${formatDateTime(
            result.message.sent_at,
          )}. Follow-up #1 is due ${formatDate(result.nextFollowUpAt)}.`,
        });
      } else {
        setNotice({
          kind: "info",
          text: `Recorded as sent at ${formatDateTime(
            result.message.sent_at,
          )}. No further follow-up will be scheduled.`,
        });
      }

      // The duplicate badge is derived from sent_at, so it must be re-read.
      void runDuplicateCheck(values.recipient);
    } finally {
      setSaving(false);
    }
  }

  function handleOpenFromHistory(row: OutreachHistoryRow) {
    setValues({
      recipient: row.email,
      subject: row.latestSubject ?? "",
      body: "",
      companyName: row.company_name ?? "",
      contactName: row.contact_name ?? "",
      messageId: null,
      // The overview view exposes the lead id but not the message id, so a
      // re-opened row must be saved before it can be recorded as sent.
      leadId: row.id,
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
            // New text invalidates an earlier "yes I checked that" answer.
            setWarningsConfirmed(false);
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
          gate={gate}
          gatePending={gatePending}
          warningsConfirmed={warningsConfirmed}
        />
      ) : null}

      <OutreachHistory rows={initialRows} onLoadIntoComposer={handleOpenFromHistory} />
    </div>
  );
}