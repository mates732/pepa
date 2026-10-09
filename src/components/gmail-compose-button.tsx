"use client";

import { useState } from "react";

import type { GmailComposeInput } from "@/lib/outreach/gmail-compose-client";
import { openGmailCompose } from "@/lib/outreach/open-gmail-compose";

/**
 * "Open in Gmail" button — the single shared implementation.
 *
 * WHY THIS COMPONENT EXISTS. Every active UI entry point that opens Gmail
 * used to have its own four-step ceremony: build the URL, call window.open,
 * handle the null return, and surface a manual fallback. Those copies drifted:
 * some reserved a blank tab synchronously, some opened the URL directly, some
 * awaited a server action first, and none agreed on what to report when the
 * browser blocked the tab.
 *
 * This button owns the behaviour instead. The caller supplies the draft data
 * (recipient, subject, body) — never a URL, never a server action — and this
 * component does the opening. That keeps the URL builder, the popup-blocking
 * fallback and the "never claim success" rule in one place, tested once.
 *
 * SECURITY. The caller supplies raw draft data, which is already rendered on
 * this page and comes from the database. No value typed into this component
 * can influence what Gmail receives. Opening Gmail writes nothing: the
 * operator still presses Send in Gmail, and that stays the only step that
 * sends an email.
 */
export function GmailComposeButton({
  input,
  label = "Open in Gmail ↗",
  pendingLabel = "Opening…",
  successText = "Opened Gmail compose with the saved draft. Press Send in Gmail yourself.",
  blockedText = "Your browser blocked the new tab.",
}: {
  input: GmailComposeInput;
  label?: string;
  pendingLabel?: string;
  successText?: string;
  blockedText?: string;
}) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  function handleClick() {
    setPending(true);
    setNotice(null);

    // Synchronous, inside the click: the user gesture is still live here,
    // which is the entire reason window.open succeeds when called directly.
    const result = openGmailCompose(input, { successMessage: successText, blockedMessage: blockedText });

    setNotice({ kind: result.opened ? "info" : "error", text: result.message });
    setPending(false);
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="btn"
        title="Opens a Gmail draft with this saved text. This does not send anything."
      >
        {pending ? pendingLabel : label}
      </button>

      {notice ? (
        <p role="status" className={notice.kind === "error" ? "notice notice-alarm" : "notice"}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}