"use client";

/**
 * "Otevřít aplikaci Gmail" — test anchor for the iOS Gmail app scheme.
 *
 * The `googlegmail://` URL scheme is community-reported only (no official
 * Google documentation; see report). The href stays a real anchor with the
 * literal scheme — the click is what iOS intercepts and hands to the app —
 * and the page itself is never navigated: no window.location assignment, no
 * automatic redirect.
 *
 * The not-installed guard shares the production helper: if the page was
 * never backgrounded (the app did not open), a MANUAL banner offers the
 * verified web URL; the operator clicks it deliberately. A page that WAS
 * backgrounded — the normal case when the app opens — suppresses the
 * fallback permanently, so returning from Gmail can never replace this page
 * with mail.google.com (timers are suspended, not cancelled, while
 * backgrounded; that flaw is why the old auto-assign version is gone).
 *
 * This only navigates the Gmail app. Nothing here sends email.
 */

import { armManualWebFallback } from "@/lib/outreach/open-gmail-compose";

const APP_SCHEME = "googlegmail://";
const APP_COMPOSE_SCHEME = "googlegmail:///co?";
const FALLBACK_WEB_URL = "https://mail.google.com/mail/mu/mp/399/#";
const FALLBACK_DELAY_MS = 1500;

export function GmailAppLink() {
  const handleClick = () => {
    armManualWebFallback(FALLBACK_WEB_URL);
  };

  return (
    <a
      href={APP_SCHEME}
      onClick={handleClick}
      className="mt-4 inline-flex w-full items-center justify-center rounded-[0.75rem] border-[2px] border-midnight bg-midnight px-6 py-4 text-base font-bold text-cream transition-opacity hover:opacity-90"
    >
      Otevřít aplikaci Gmail
    </a>
  );
}

/** Exported for tests: the exact scheme and compose-scheme strings under test. */
export const GMAIL_APP_LINK_CONSTANTS = {
  APP_SCHEME,
  APP_COMPOSE_SCHEME,
  FALLBACK_WEB_URL,
  FALLBACK_DELAY_MS,
} as const;
