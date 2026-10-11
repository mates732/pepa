"use client";

/**
 * "Otevřít aplikaci Gmail" — test anchor for the iOS Gmail app scheme.
 *
 * The `googlegmail://` URL scheme is community-reported only (no official
 * Google documentation; see report). The href stays a real anchor with the
 * literal scheme, and the only JS is a not-installed guard: on click we
 * remember the verified working web URL, then after a short delay — if this
 * page is still visible, meaning iOS did not hand off to the app — we send
 * the browser there instead. When the app does open, the page is hidden and
 * the fallback never fires.
 *
 * This only navigates. Nothing here sends email.
 */

const APP_SCHEME = "googlegmail://";
const APP_COMPOSE_SCHEME = "googlegmail:///co?";
const FALLBACK_WEB_URL = "https://mail.google.com/mail/mu/mp/399/#";
const FALLBACK_DELAY_MS = 1500;

export function GmailAppLink() {
  const handleClick = () => {
    if (typeof window === "undefined") return;

    window.setTimeout(() => {
      // The page is still in the foreground: the app was not installed (or
      // refused the scheme), so send the user to the web UI that is known to
      // work on iPhone instead of leaving a dead end.
      if (typeof document !== "undefined" && !document.hidden) {
        window.location.assign(FALLBACK_WEB_URL);
      }
    }, FALLBACK_DELAY_MS);
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
