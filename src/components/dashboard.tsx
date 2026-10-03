"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  checkQualityGate,
  checkRecipient,
  loadFollowUpDetail,
  loadFollowUpWorkspace,
  openOutreachInGmail,
  recordOutreachSent,
  saveDraft,
} from "@/app/actions";
import { EmailComposer, type ComposerValues } from "@/components/email-composer";
import { FollowUpDetail } from "@/components/follow-up-detail";
import { FollowUpWorkspace } from "@/components/follow-up-workspace";
import { OutreachHistory } from "@/components/outreach-history";
import { PasteImport } from "@/components/paste-import";
import { formatDate, formatDateTime } from "@/lib/format";
import type { FollowUpDetail as FollowUpDetailData, FollowUpListItem } from "@/lib/services/follow-up-sequence-service";
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
  const [openingGmail, setOpeningGmail] = useState(false);

  // Follow-ups workspace. Loaded once on mount and refreshed after a send, so
  // the list reflects stored state rather than an optimistic local guess.
  const [followUps, setFollowUps] = useState<FollowUpListItem[]>([]);
  const [followUpsLoading, setFollowUpsLoading] = useState(true);
  const [followUpsError, setFollowUpsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FollowUpDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailNotice, setDetailNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [recordingDetail, setRecordingDetail] = useState(false);

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

  /**
   * Open the stored draft in Gmail.
   *
   * The browser sends only a message id; the server resolves recipient, subject
   * and body from the database and returns a compose URL. Opening it changes
   * nothing in PEPA: no status, no `sent_at`, no counter. Recording the send stays
   * an explicit, separate action.
   */
  async function handleOpenInGmail() {
    if (!values.messageId) {
      setNotice({ kind: "error", text: "Save the draft first, then open it in Gmail." });
      return;
    }

    setOpeningGmail(true);
    try {
      const result = await openOutreachInGmail(values.messageId);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }

      window.open(result.url, "_blank", "noopener,noreferrer");
      setNotice({
        kind: "info",
        text: "Gmail opened with the saved text. Nothing was sent — use “Mark as sent” after you send it yourself.",
      });
    } finally {
      setOpeningGmail(false);
    }
  }

  /** Load the workspace once. Read-only: opening it records nothing. */
  const loadWorkspace = useCallback(async () => {
    setFollowUpsLoading(true);
    try {
      const result = await loadFollowUpWorkspace();
      if (result.ok) {
        setFollowUps(result.followUps);
        setFollowUpsError(null);
      } else {
        setFollowUpsError(result.error);
      }
    } finally {
      setFollowUpsLoading(false);
    }
  }, []);

  // Deferred for the same reason the gate and duplicate checks are: a fetch
  // that synchronously flips loading state would cascade a second render.
  useEffect(() => {
    const handle = setTimeout(() => void loadWorkspace(), 0);
    return () => clearTimeout(handle);
  }, [loadWorkspace]);

  /** Open one follow-up's exact message. */
  const handleSelectFollowUp = useCallback(async (messageId: string) => {
    setSelectedId(messageId);
    setDetailNotice(null);
    setDetailLoading(true);
    try {
      const result = await loadFollowUpDetail(messageId);
      if (result.ok) {
        setDetail(result.detail);
      } else {
        // The server refused (unknown id, or a lead that no longer exists).
        setDetail(null);
        setDetailNotice({ kind: "error", text: result.error });
      }
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /**
   * Open a follow-up in Gmail from the detail view.
   *
   * Reuses the Phase 4B server action, so recipient, subject and body are
   * resolved from the database and nothing is written. Opening Gmail is not
   * sending; that stays a separate, explicit action.
   */
  async function handleOpenDetailInGmail(messageId: string) {
    setOpeningGmail(true);
    setDetailNotice(null);
    try {
      const result = await openOutreachInGmail(messageId);
      if (!result.ok) {
        setDetailNotice({ kind: "error", text: result.error });
        return;
      }
      window.open(result.url, "_blank", "noopener,noreferrer");
      setDetailNotice({
        kind: "info",
        text: "Gmail opened with the saved text. Nothing was sent — use “Mark as sent” after you send it yourself.",
      });
    } finally {
      setOpeningGmail(false);
    }
  }

  /**
   * Record a follow-up as sent.
   *
   * Goes through the existing authenticated action, so the server-authoritative
   * quality gate runs before anything is persisted. On success the workspace and
   * the detail are re-read from the database; on failure the local state is left
   * untouched, because nothing was written.
   */
  async function handleMarkDetailSent(messageId: string, leadId: string) {
    setRecordingDetail(true);
    setDetailNotice(null);
    try {
      const result = await recordOutreachSent({ messageId, leadId });

      // Refusals (gate blocked / needs confirmation) arrive as `ok: false` with
      // an `outcome`. Nothing was written, so local state stays untouched.
      if (!result.ok) {
        const refusal = "outcome" in result ? result : null;
        setDetailNotice({
          kind: "error",
          text:
            refusal?.outcome === "needs_confirmation"
              ? `${result.error} Confirm the warnings to continue.`
              : result.error,
        });
        return;
      }

      if (result.outcome === "already_sent") {
        setDetailNotice({ kind: "info", text: "Already recorded as sent. Nothing was changed." });
      } else {
        setDetailNotice({ kind: "info", text: "Recorded as sent. The next follow-up is scheduled." });
      }

      // Re-read from the server rather than patching local state, so the UI can
      // never claim a send the database does not hold.
      await loadWorkspace();
      await handleSelectFollowUp(messageId);
    } finally {
      setRecordingDetail(false);
    }
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
          onOpenInGmail={handleOpenInGmail}
          openingGmail={openingGmail}
        />
      ) : null}

      <OutreachHistory rows={initialRows} onLoadIntoComposer={handleOpenFromHistory} />

      <FollowUpWorkspace
        followUps={followUps}
        onSelect={(id) => void handleSelectFollowUp(id)}
        loading={followUpsLoading}
        error={followUpsError}
        selectedId={selectedId}
      />

      {detailLoading ? (
        <section className="sticker">
          <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
            Loading follow-up…
          </p>
        </section>
      ) : detail ? (
        <FollowUpDetail
          detail={detail}
          onClose={() => {
            setDetail(null);
            setSelectedId(null);
            setDetailNotice(null);
          }}
          onOpenInGmail={(id) => void handleOpenDetailInGmail(id)}
          onMarkSent={(id, leadId) => void handleMarkDetailSent(id, leadId)}
          openingGmail={openingGmail}
          recording={recordingDetail}
          notice={detailNotice}
        />
      ) : null}
    </div>
  );
}