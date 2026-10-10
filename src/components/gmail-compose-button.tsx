"use client";

import { useCallback } from "react";

import type { GmailComposeInput } from "@/lib/outreach/gmail-compose-client";
import { openGmailCompose } from "@/lib/outreach/open-gmail-compose";

/**
 * "Open in Gmail" button — the single shared implementation.
 *
 * Opens Gmail compose in the same tab using window.location.assign(),
 * which avoids popup blocking on iOS Safari and other mobile browsers.
 *
 * The caller supplies the draft data (recipient, subject, body) — never
 * a URL, never a server action — and this component handles the navigation.
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
  disabled = false,
  title = "Opens a Gmail draft with this saved text. This does not send anything.",
}: {
  input: GmailComposeInput;
  label?: string;
  disabled?: boolean;
  title?: string;
}) {
  const handleClick = useCallback(() => {
    // Synchronous, inside the click: the user gesture is still live here.
    // Uses same-tab navigation to avoid popup blocking on mobile browsers.
    openGmailCompose(input);
  }, [input]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="btn"
      title={title}
    >
      {label}
    </button>
  );
}