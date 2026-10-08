"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  loadOutreachActivity,
  loadOutreachActivityDetail,
} from "@/app/activity-actions";
import {
  checkQualityGate,
  checkRecipient,
  bulkDeleteLeadsFromHistory,
  bulkMarkOutreachSent,
  deleteLeadFromHistory,
  deleteOutreachMessage,
  loadFollowUpDetail,
  loadInitialOutreachDetail,
  loadLeadOutreachPair,
  loadFollowUpWorkspace,
  loadHistoryRows,
  openOutreachInGmail,
  recordOutreachSent,
  saveDraft,
} from "@/app/actions";
import type { BulkEmailCandidate } from "@/lib/import/bulk-emails";
import {
  EmailComposer,
  type ComposerValues,
} from "@/components/email-composer";
import { FollowUpDetail } from "@/components/follow-up-detail";
import { FollowUpWorkspace } from "@/components/follow-up-workspace";
import { createFollowUp } from "@/app/followup-actions";
import { loadOutreachStats } from "@/app/stats-actions";
import { loadOutreachStreaks } from "@/app/streak-actions";
import { OutreachActivity } from "@/components/outreach-activity";
import { OutreachActivityDetail } from "@/components/outreach-activity-detail";
import { OutreachHistory } from "@/components/outreach-history";
import { OutreachStats } from "@/components/outreach-stats";
import { OutreachStreaks } from "@/components/outreach-streaks";
import { PasteImport } from "@/components/paste-import";
import { BulkImport } from "@/components/bulk-import";
import { formatDate, formatDateTime } from "@/lib/format";
import { composerValuesFromSavedMessage } from "@/lib/outreach/composer-values";
import {
  closeComposeWindow,
  navigateComposeWindow,
  preopenComposeWindow,
} from "@/lib/outreach/open-compose-window";
import type {
  FollowUpDetail as FollowUpDetailData,
  FollowUpListItem,
} from "@/lib/services/follow-up-sequence-service";
import type {
  OutreachActivityDetail as OutreachActivityDetailData,
  OutreachActivityItem,
} from "@/lib/services/outreach-activity-service";
import type { GateEvaluation } from "@/lib/services/outreach-quality-gate";
import type { DuplicateCheckResult, OutreachHistoryRow } from "@/lib/types";

const EMPTY: ComposerValues = {
  recipient: "",
  mainSubject: "",
  mainBody: "",
  followUpSubject: "",
  followUpBody: "",
  companyName: "",
  contactName: "",
  messageId: null,
  followUpMessageId: null,
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

export function Dashboard({
  initialRows,
  initialFollowUpId,
}: {
  initialRows: OutreachHistoryRow[];
  /**
   * Phase 8B. Set by the server from a `?followup=<token>` deep link, after that
   * token was resolved server-side. Never a client-supplied id, which is why the
   * server passes it down rather than reading it here.
   */
  initialFollowUpId?: string | null;
}) {
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
  const [detailNotice, setDetailNotice] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);
  const [recordingDetail, setRecordingDetail] = useState(false);
  const [creatingFollowUp, setCreatingFollowUp] = useState(false);
  const [deletingDetail, setDeletingDetail] = useState(false);
  const [openingDetailId, setOpeningDetailId] = useState<string | null>(null);
  const [openingComposerRowId, setOpeningComposerRowId] = useState<
    string | null
  >(null);
  // The history table is live: deleting an unsent lead removes it
  // from this list without a round trip through the server page.
  const [rows, setRows] = useState<OutreachHistoryRow[]>(initialRows);
  const [deletingRowId, setDeletingRowId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Activity workspace. Read-only: opening it records nothing, and it exposes no
  // mutation controls, so there is nothing here that can write.
  const [activity, setActivity] = useState<OutreachActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityTruncated, setActivityTruncated] = useState(false);
  const [activityLimit, setActivityLimit] = useState(0);
  const [activitySelectedId, setActivitySelectedId] = useState<string | null>(
    null,
  );
  const [activityDetail, setActivityDetail] =
    useState<OutreachActivityDetailData | null>(null);
  const [activityDetailLoading, setActivityDetailLoading] = useState(false);
  const [activityNotice, setActivityNotice] = useState<{
    kind: "info" | "error";
    text: string;
  } | null>(null);

  // Stats. Read-only and server-counted: the browser never holds a message row,
  // only the seven figures. The reader's zone is sent so the server can resolve
  // where each window starts; every count still comes from the database.
  const [stats, setStats] = useState<{
    today: number;
    week: number;
    month: number;
    allTime: number;
    initialOutreach: number;
    followUps: number;
    totalSent: number;
  } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsComplete, setStatsComplete] = useState(true);
  const [statsTimeZone, setStatsTimeZone] = useState<string | null>(null);

  // Streaks. Also read-only and server-counted. The two completeness flags are
  // server facts, not UI choices: the browser never decides whether the history
  // it was given is the whole history.
  const [streaks, setStreaks] = useState<{
    currentStreak: number;
    longestStreak: number;
    activeDaysThisWeek: number;
    activeDaysThisMonth: number;
    totalActiveDays: number;
    daysInWeek: number;
    daysInMonth: number;
  } | null>(null);
  const [streaksLoading, setStreaksLoading] = useState(true);
  const [streaksError, setStreaksError] = useState<string | null>(null);
  const [streaksComplete, setStreaksComplete] = useState(true);
  const [streaksCurrentExact, setStreaksCurrentExact] = useState(true);
  const [streaksTimeZone, setStreaksTimeZone] = useState<string | null>(null);

  /**
   * The calendar the operator is actually reading in.
   *
   * Read in the browser, because that is where it exists: a serverless runtime
   * has UTC and would count the wrong day. Only the zone name is sent — no
   * boundaries, no counts — so the server still owns the arithmetic.
   */
  function readerTimeZone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const result = await loadOutreachStats({ timeZone: readerTimeZone() });
      if (result.ok) {
        setStats(result.stats);
        setStatsComplete(result.complete);
        setStatsTimeZone(result.timeZone);
        setStatsError(null);
      } else {
        setStatsError(result.error);
      }
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => void loadStats(), 0);
    return () => clearTimeout(handle);
  }, [loadStats]);

  /**
   * Load the streaks from the server.
   *
   * Never patched locally. A newly recorded send might be the first one today,
   * which starts a day, or the fourth one today, which changes nothing at all —
   * the database is the only thing that can tell those apart.
   */
  const loadStreaks = useCallback(async () => {
    setStreaksLoading(true);
    try {
      const result = await loadOutreachStreaks({ timeZone: readerTimeZone() });
      if (result.ok) {
        setStreaks(result.streaks);
        setStreaksComplete(result.complete);
        setStreaksCurrentExact(result.currentStreakComplete);
        setStreaksTimeZone(result.timeZone);
        setStreaksError(null);
      } else {
        setStreaksError(result.error);
      }
    } finally {
      setStreaksLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => void loadStreaks(), 0);
    return () => clearTimeout(handle);
  }, [loadStreaks]);

  const valuesRef = useRef(values);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  const runDuplicateCheck = useCallback(async (recipient: string) => {
    if (!recipient.trim()) {
      setDuplicate(null);
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
        subject: valuesRef.current.mainSubject,
        body: valuesRef.current.mainBody,
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
    const handle = setTimeout(
      () => void runDuplicateCheck(values.recipient),
      400,
    );
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
    values.mainSubject,
    values.mainBody,
    values.messageId,
    values.leadId,
    hasContent,
    runGateCheck,
  ]);

  function handleParsed(parsed: BulkEmailCandidate) {
    setValues((current) => ({
      ...current,
      recipient: parsed.recipient || current.recipient,
      mainSubject: parsed.subject || current.mainSubject,
      mainBody: parsed.body || current.mainBody,
    }));
    setHasContent(true);
    setSaved(false);
    setDuplicateError(parsed.warnings.join(" "));
    if (parsed.recipient) {
      void runDuplicateCheck(parsed.recipient);
    }
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
   * Open the stored draft in the default mail client (mailto:) or Gmail web.
   *
   * The browser sends only a message id; the server resolves recipient, subject
   * and body from the database and returns both a mailto: URL (for the system
   * default mail client — Gmail app/PWA if configured as default) and a Gmail
   * web compose URL (fallback). Opening it changes nothing in PEPA: no status,
   * no `sent_at`, no counter. Recording the send stays an explicit, separate action.
   */
  async function handleOpenInGmail() {
    if (!values.messageId) {
      setNotice({
        kind: "error",
        text: "Save the draft first, then open it in Gmail.",
      });
      return;
    }

    setOpeningGmail(true);
    // Reserve a tab synchronously, inside the click, so the popup blocker still
    // accepts it. See lib/outreach/open-compose-window.ts for why.
    const tab = preopenComposeWindow();
    try {
      const result = await openOutreachInGmail(values.messageId);
      if (!result.ok) {
        closeComposeWindow(tab);
        setNotice({ kind: "error", text: result.error });
        return;
      }

      // Try mailto: first — this opens the system default mail client.
      // If the user has Gmail set as default handler (in OS settings), this opens Gmail app/PWA.
      const mailtoOpened =
        tab && !tab.closed && navigateComposeWindow(tab, result.mailtoUrl);

      // Also open Gmail web in a new tab as a reliable fallback.
      // This ensures the user always has a working compose window.
      const webTab = preopenComposeWindow();
      const webOpened =
        webTab &&
        !webTab.closed &&
        navigateComposeWindow(webTab, result.webUrl);

      if (!mailtoOpened && !webOpened) {
        // Both failed — browser blocked popups. Give the user the URLs manually.
        setNotice({
          kind: "error",
          text: `Your browser blocked the new tab. Open manually: ${result.webUrl}`,
        });
        return;
      }

      setNotice({
        kind: "info",
        text: mailtoOpened
          ? "Opened default mail client (Gmail if set as default). Also opened Gmail web as fallback."
          : "Opened Gmail web compose. Set Gmail as default mail handler to use mailto: links.",
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

  /** Load the recent window of sent outreach. Read-only, like the workspace. */
  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const result = await loadOutreachActivity();
      if (result.ok) {
        setActivity(result.activity);
        setActivityTruncated(result.truncated);
        setActivityLimit(result.limit);
        setActivityError(null);
      } else {
        setActivityError(result.error);
      }
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => void loadActivity(), 0);
    return () => clearTimeout(handle);
  }, [loadActivity]);

  /**
   * Open one activity item's exact sent outreach.
   *
   * The browser sends only a message id, so the server decides what this view
   * contains. A message that was never recorded as sent is not reachable here.
   */
  const handleSelectActivity = useCallback(async (messageId: string) => {
    setActivitySelectedId(messageId);
    setActivityNotice(null);
    setActivityDetailLoading(true);
    try {
      const result = await loadOutreachActivityDetail(messageId);
      if (result.ok) {
        setActivityDetail(result.detail);
      } else {
        setActivityDetail(null);
        setActivityNotice({ kind: "error", text: result.error });
      }
    } finally {
      setActivityDetailLoading(false);
    }
  }, []);

  /**
   * Hand a sent message to Gmail.
   *
   * Reuses the Phase 4 `openOutreachInGmail()` action, which resolves recipient,
   * subject and body from the stored row. It fills a compose window and writes
   * nothing: no status, no `sent_at`, no counter, no schedule. A message already
   * recorded as sent is not re-sent by opening it.
   */
  async function handleOpenActivityInGmail(messageId: string) {
    setOpeningGmail(true);
    setActivityNotice(null);
    const tab = preopenComposeWindow();
    try {
      const result = await openOutreachInGmail(messageId);
      if (!result.ok) {
        closeComposeWindow(tab);
        setActivityNotice({ kind: "error", text: result.error });
        return;
      }

      // Try mailto: first — opens system default mail client.
      const mailtoOpened =
        tab && !tab.closed && navigateComposeWindow(tab, result.mailtoUrl);

      // Also open Gmail web as fallback.
      const webTab = preopenComposeWindow();
      const webOpened =
        webTab &&
        !webTab.closed &&
        navigateComposeWindow(webTab, result.webUrl);

      if (!mailtoOpened && !webOpened) {
        setActivityNotice({
          kind: "error",
          text: `Your browser blocked the new tab. Open manually: ${result.webUrl}`,
        });
        return;
      }

      setActivityNotice({
        kind: "info",
        text: mailtoOpened
          ? "Opened default mail client (Gmail if set as default). Also opened Gmail web as fallback."
          : "Opened Gmail web compose. Set Gmail as default mail handler to use mailto: links.",
      });
    } finally {
      setOpeningGmail(false);
    }
  }

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
   * Phase 8B: open the follow-up a notification pointed at.
   *
   * Reuses `handleSelectFollowUp`, so the destination is the ordinary Phase 4C
   * detail and the ordinary read-only `loadFollowUpDetail` action — nothing new
   * is fetched, and nothing is written. Selecting is not sending: the detail's
   * "Mark as sent" still requires its own explicit click through the existing
   * quality-gated send-recording path.
   *
   * Deferred for the same reason the workspace load is: a fetch that flips
   * loading state synchronously would cascade a second render.
   */
  useEffect(() => {
    if (!initialFollowUpId) return;
    const handle = setTimeout(
      () => void handleSelectFollowUp(initialFollowUpId),
      0,
    );
    return () => clearTimeout(handle);
  }, [initialFollowUpId, handleSelectFollowUp]);

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
    const tab = preopenComposeWindow();
    try {
      const result = await openOutreachInGmail(messageId);
      if (!result.ok) {
        closeComposeWindow(tab);
        setDetailNotice({ kind: "error", text: result.error });
        return;
      }

      // Try mailto: first — opens system default mail client.
      const mailtoOpened =
        tab && !tab.closed && navigateComposeWindow(tab, result.mailtoUrl);

      // Also open Gmail web as fallback.
      const webTab = preopenComposeWindow();
      const webOpened =
        webTab &&
        !webTab.closed &&
        navigateComposeWindow(webTab, result.webUrl);

      if (!mailtoOpened && !webOpened) {
        setDetailNotice({
          kind: "error",
          text: `Your browser blocked the new tab. Open manually: ${result.webUrl}`,
        });
        return;
      }

      setDetailNotice({
        kind: "info",
        text: mailtoOpened
          ? "Opened default mail client (Gmail if set as default). Also opened Gmail web as fallback."
          : "Opened Gmail web compose. Set Gmail as default mail handler to use mailto: links.",
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
        setDetailNotice({
          kind: "info",
          text: "Already recorded as sent. Nothing was changed.",
        });
      } else {
        setDetailNotice({
          kind: "info",
          text: "Recorded as sent. The next follow-up is scheduled.",
        });
      }

      // Re-read from the server rather than patching local state, so the UI can
      // never claim a send the database does not hold.
      await loadWorkspace();
      // A newly recorded send is a new activity row, so the window is re-read
      // too. Activity is never patched locally either.
      await loadActivity();
      // A recorded send moves every count, so stats are re-read too rather than
      // incremented locally.
      await loadStats();
      // Streaks are re-read for the same reason, and with the same restraint:
      // whether this send started a new active day is a fact about the
      // database, not something the browser may assume.
      await loadStreaks();
      await handleSelectFollowUp(messageId);
    } finally {
      setRecordingDetail(false);
    }
  }

  /**
   * Delete a single outreach message from the detail view.
   *
   * Called when the operator confirms deletion in the FollowUpDetail dialog.
   * On success, the detail view is closed and the workspace is refreshed.
   */
  async function handleDeleteOutreachMessage(messageId: string) {
    setDeletingDetail(true);
    setDetailNotice(null);
    try {
      const result = await deleteOutreachMessage({ messageId });
      if (!result.ok) {
        setDetailNotice({ kind: "error", text: result.error });
        return;
      }
      setDetailNotice({ kind: "info", text: "Outreach message deleted." });
      // Close the detail view and refresh the workspace
      setDetail(null);
      setSelectedId(null);
      await loadWorkspace();
      await loadActivity();
      await loadStats();
      await loadStreaks();
    } finally {
      setDeletingDetail(false);
    }
  }

  /**
   * Phase 8F: draft the next follow-up in a sequence from the detail view.
   *
   * The anchor is the message on screen and the server resolves everything else,
   * so the browser cannot choose a lead or a recipient. Refusals (`conflict`,
   * `anchor_not_latest`, `not_found`) are shown as-is and nothing is patched
   * locally: the new row exists in the UI only after the database has it.
   */
  async function handleCreateDetailFollowUp(
    parentMessageId: string,
    subject: string,
    body: string,
  ) {
    setCreatingFollowUp(true);
    setDetailNotice(null);
    try {
      const result = await createFollowUp({ parentMessageId, subject, body });

      if (!result.ok) {
        setDetailNotice({ kind: "error", text: result.error });
        return;
      }

      await loadWorkspace();
      // Open the row the server actually wrote, so the operator continues from
      // the stored sequence rather than from anything the browser predicted.
      await handleSelectFollowUp(result.messageId);
      setDetailNotice({
        kind: "info",
        text: result.created
          ? `Follow-up #${result.sequenceNumber} saved as a draft. Nothing was sent and nobody was notified.`
          : "That follow-up was updated in place — no second row was created.",
      });
    } finally {
      setCreatingFollowUp(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setNotice(null);
    try {
      const result = await saveDraft({
        recipientEmail: values.recipient,
        mainSubject: values.mainSubject,
        mainBody: values.mainBody,
        followUpSubject: values.followUpSubject,
        followUpBody: values.followUpBody,
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
        followUpMessageId: result.followUp?.id ?? null,
        leadId: result.lead.id,
        companyName: result.lead.company_name ?? current.companyName,
        contactName: result.lead.contact_name ?? current.contactName,
      }));
      setSaved(true);
      setNotice({
        kind: "info",
        text: `Draft saved for ${result.lead.email}.`,
      });
      void runDuplicateCheck(result.lead.email);
      setFocusSignal((n) => n + 1);

      // Refresh the history table row for this lead so the client never keeps a
      // stale unsent / subject / body after a successful save. The initial render
      // was produced once by the server; edits happen client-side and write back
      // to the database, so the in-memory rows can drift from what the database
      // now says about this lead. The read itself runs as a server action — a
      // client component may not import the Postgres service directly.
      const refreshed = await loadHistoryRows();
      if (refreshed.ok) {
        setRows((current) =>
          current.map((row) => {
            if (row.id !== result.lead.id) return row;
            const match = refreshed.rows.find((r) => r.id === row.id);
            return match ?? row;
          }),
        );
      }
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

      // The duplicate badge is derived from sent_at, so it must be re-read. The
      // same send is also a new activity record.
      void runDuplicateCheck(values.recipient);
      void loadActivity();
      void loadStats();
      void loadStreaks();
    } finally {
      setSaving(false);
    }
  }

  /**
   * Phase 8F: open a lead's sequence detail from Outreach history.
   *
   * The browser sends the lead id only; the server resolves which stored row is
   * that lead's sequence head, so this cannot open an arbitrary message. The
   * resulting detail is the ordinary one, which means the "Next follow-up" form
   * is reachable even when the newest row is still the sequence-0 draft — the
   * case the Follow-ups workspace cannot show.
   *
   * Read-only: nothing is written, and the composer action beside it is
   * untouched.
   */
  async function handleOpenHistoryDetail(row: OutreachHistoryRow) {
    setOpeningDetailId(row.id);
    setDetailNotice(null);
    setDetailLoading(true);
    try {
      const result = await loadInitialOutreachDetail({ leadId: row.id });
      if (!result.ok) {
        setDetail(null);
        setSelectedId(null);
        setDetailNotice({ kind: "error", text: result.error });
        return;
      }
      // Selected id comes from the resolved detail, not from the row.
      setDetail(result.detail);
      setSelectedId(result.detail.message.id);
    } finally {
      setDetailLoading(false);
      setOpeningDetailId(null);
    }
  }

  /**
   * Outreach history → composer.
   *
   * The composer is filled from the message the DATABASE says is this lead's
   * initial outreach, resolved server-side by `loadInitialOutreachDetail`. The
   * browser names a lead, never a message: the row in the history table carries
   * no message id at all, which is exactly why rebuilding the composer from the
   * row used to force `messageId: null` and leave "Open in Gmail" permanently
   * disabled.
   *
   * This is a read. It writes nothing, sends nothing and marks nothing, and the
   * fallback below is the only case where no stored message exists at all.
   */
  /**
   * Delete an unsent lead.
   *
   * The server refuses any lead whose primary outreach has
   * actually left the outbox, so a sent lead's history is never
   * at risk here. On success the lead — its primary draft and
   * every pending follow-up with it — disappears from the table,
   * and the follow-up workspace is refreshed so a removed
   * follow-up cannot linger in it.
   */
  /**
   * "Smazat z historie" — remove the lead from history and the database,
   * sent or unsent. The row leaves this table the moment the server
   * confirms: the in-memory rows are filtered immediately, so the UI
   * refreshes without a round trip through the server page.
   */
  async function handleDeleteLead(row: OutreachHistoryRow) {
    setDeletingRowId(row.id);
    setNotice(null);
    try {
      const result = await deleteLeadFromHistory({ leadId: row.id });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setRows((current) => current.filter((lead) => lead.id !== row.id));
      setNotice({
        kind: "info",
        text: `Deleted ${row.email} from history and the database.`,
      });
      void loadWorkspace();
    } finally {
      setDeletingRowId(null);
    }
  }

  /**
   * Bulk delete selected leads.
   */
  async function handleBulkDeleteLeads(leadIds: string[]) {
    setDeletingRowId("bulk");
    setNotice(null);
    try {
      const result = await bulkDeleteLeadsFromHistory({ leadIds });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setRows((current) =>
        current.filter((lead) => !leadIds.includes(lead.id)),
      );
      setNotice({
        kind: "info",
        text: `Deleted ${result.deleted} lead(s) from history and the database.`,
      });
      void loadWorkspace();
    } finally {
      setDeletingRowId(null);
      setSelectedIds([]);
    }
  }

  /**
   * Bulk mark selected leads' outreach as sent.
   */
  async function handleBulkMarkSent(leadIds: string[]) {
    setNotice(null);
    try {
      const result = await bulkMarkOutreachSent({ leadIds });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setNotice({
        kind: "info",
        text: `Marked ${result.marked} outreach message(s) as sent.`,
      });
      void loadWorkspace();
      void loadActivity();
      void loadStats();
      void loadStreaks();
    } finally {
      setSelectedIds([]);
    }
  }

  async function handleOpenFromHistory(row: OutreachHistoryRow) {
    setOpeningComposerRowId(row.id);
    setNotice(null);
    try {
      const result = await loadLeadOutreachPair({ leadId: row.id });

      if (!result.ok) {
        // No stored initial outreach for this lead. Fall back to what the row
        // genuinely knows, say so, and let the disabled Gmail button explain
        // itself rather than looking like a button that simply refuses.
        setValues({
          recipient: row.email,
          mainSubject: row.latestSubject ?? "",
          mainBody: "",
          followUpSubject: "",
          followUpBody: "",
          companyName: row.company_name ?? "",
          contactName: row.contact_name ?? "",
          messageId: null,
          followUpMessageId: null,
          leadId: row.id,
        });
        setHasContent(true);
        setSaved(false);
        setNotice({
          kind: "error",
          text:
            result.error ??
            "That lead has no saved draft yet. Save this one before opening it in Gmail.",
        });
        void runDuplicateCheck(row.email);
        window.scrollTo({ top: 0 });
        return;
      }

      setValues(
        composerValuesFromSavedMessage({
          lead: result.lead,
          mainMessage: result.main,
          followUpMessage: result.followUp,
        }),
      );
      setHasContent(true);
      // The content in the composer IS the stored draft, so it is saved by
      // definition. Saying otherwise would grey out the controls that are
      // actually valid here.
      setSaved(true);
      setNotice({
        kind: "info",
        text: "Loaded the saved draft. “Open in Gmail” now uses that saved text.",
      });
      void runDuplicateCheck(row.email);
      window.scrollTo({ top: 0 });
    } finally {
      setOpeningComposerRowId(null);
    }
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
      <OutreachStats
        stats={stats}
        loading={statsLoading}
        error={statsError}
        complete={statsComplete}
        timeZone={statsTimeZone}
      />

      <PasteImport
        onParsed={handleParsed}
        onError={(message) => {
          setDuplicateError(null);
          setNotice({ kind: "error", text: message });
        }}
        focusSignal={focusSignal}
        disabled={false}
      />

      {/*
        Paste Emails sits directly under the single-lead paste bar because it is
        the same job for many messages at once. It creates DRAFTS only, with the
        operator's text unchanged — composing in Gmail and recording the send stay
        the explicit per-draft actions in the composer, where the quality gate and
        the historical hard stop enforce themselves.
      */}
      <BulkImport
        onImported={({ created, existing, skipped }) => {
          setNotice({
            kind: "info",
            text:
              `${created} draft${created === 1 ? "" : "s"} saved` +
              `${existing > 0 ? `, ${existing} already existed` : ""}` +
              `${skipped > 0 ? `, ${skipped} skipped` : ""}. Open each one to send it yourself — nothing was sent.`,
          });
        }}
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

      <OutreachHistory
        rows={rows}
        onLoadIntoComposer={(row) => void handleOpenFromHistory(row)}
        openingComposerRowId={openingComposerRowId}
        onOpenDetail={(row) => void handleOpenHistoryDetail(row)}
        openingDetailId={openingDetailId}
        onDelete={(row) => void handleDeleteLead(row)}
        deletingRowId={deletingRowId}
        onBulkDelete={(ids) => void handleBulkDeleteLeads(ids)}
        onBulkMarkSent={(ids) => void handleBulkMarkSent(ids)}
        selectedIds={selectedIds}
        onSelectionChange={(ids) => setSelectedIds(ids)}
      />

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
          onCreateFollowUp={(id, subject, body) =>
            void handleCreateDetailFollowUp(id, subject, body)
          }
          onDelete={(id) => void handleDeleteOutreachMessage(id)}
          openingGmail={openingGmail}
          recording={recordingDetail}
          creating={creatingFollowUp}
          deleting={deletingDetail}
          notice={detailNotice}
        />
      ) : null}

      <OutreachActivity
        activity={activity}
        onSelect={(id) => void handleSelectActivity(id)}
        loading={activityLoading}
        error={activityError}
        selectedId={activitySelectedId}
        truncated={activityTruncated}
        limit={activityLimit}
      />

      {activityDetailLoading ? (
        <section className="sticker">
          <p className="m-5 rounded-[1.25rem] border-[3px] border-dashed border-midnight-line bg-midnight-faint/40 px-5 py-8 text-center text-sm font-semibold text-midnight-soft">
            Loading sent outreach…
          </p>
        </section>
      ) : activityDetail ? (
        <OutreachActivityDetail
          detail={activityDetail}
          onClose={() => {
            setActivityDetail(null);
            setActivitySelectedId(null);
            setActivityNotice(null);
          }}
          onOpenInGmail={(id) => void handleOpenActivityInGmail(id)}
          openingGmail={openingGmail}
          notice={activityNotice}
        />
      ) : activityNotice ? (
        <p className="notice notice-alarm">{activityNotice.text}</p>
      ) : null}

      <OutreachStreaks
        streaks={streaks}
        loading={streaksLoading}
        error={streaksError}
        complete={streaksComplete}
        currentStreakComplete={streaksCurrentExact}
        timeZone={streaksTimeZone}
      />
    </div>
  );
}
