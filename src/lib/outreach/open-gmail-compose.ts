/**
 * Shared client-side Gmail compose opener.
 *
 * The ONE place draft entry points navigate to Gmail. Three openers:
 *   1. openGmailCompose: web compose (https://mail.google.com/mail/?view=cm&fs=1...)
 *      in the same tab. Reliable on all platforms including iOS Safari.
 *   2. openGmailAppCompose: the iPhone-verified native app deep link
 *      (googlegmail:///co?to=...&subject=...&body=...) with a not-installed
 *      guard that falls back to web compose if the app does not take over.
 *   3. openGmailComposeSmart: platform-aware wrapper — on iOS it opens the
 *      native app (verified on the operator's device), everywhere else it
 *      opens web compose. This is what the draft entry points call.
 *
 * WHAT THIS DOES
 *   - Build the Gmail compose URL from draft data the caller already has — no
 *     server round trip.
 *   - Navigate with window.location.assign() (same tab) to avoid popup blocking.
 *
 * WHAT THIS DOES NOT DO
 *   - It never sends. The operator presses Send in Gmail; that is the only step
 *     that sends an email.
 *   - It writes nothing. Opening a draft never changes its status; only the
 *     explicit "Mark as sent" action records a send.
 *   - It does not guarantee the Gmail app will open. The scheme is
 *     community-reported (not officially documented by Google), the app must be
 *     installed, and iOS may show a picker dialog — hence the web fallback.
 */

import {
  buildComposeUrls,
  buildGmailAppUrl,
  buildGmailComposeUrl,
  type GmailComposeInput,
} from "./gmail-compose";

export interface OpenGmailComposeResult {
  /** Whether browser navigation was attempted (always true for same-tab navigation). */
  navigated: boolean;
  /** The URL that was (or would be) navigated to. */
  url: string;
  /**
   * Web compose URL armed as the not-installed fallback. Only set on the app
   * deep-link path: if the page is still foreground after the hand-off window,
   * the browser is sent here instead of leaving a dead end.
   */
  fallbackUrl?: string;
}

/**
 * How long to wait before concluding the Gmail app did not open. Matches the
 * delay proven on the /gmail test bench (GmailAppLink) on the real iPhone.
 */
export const GMAIL_APP_FALLBACK_DELAY_MS = 1500;

/**
 * Open Gmail compose with the given draft data.
 *
 * Navigates to the browser compose URL in the same tab. This is the reliable
 * default that works on all platforms.
 */
export function openGmailCompose(
  input: GmailComposeInput,
): OpenGmailComposeResult {
  const urls = buildComposeUrls(input);
  const url = urls.web;

  // Browser compose: navigate in same tab to avoid popup blocking.
  if (typeof window !== "undefined") {
    window.location.assign(url);
  }

  return {
    navigated: true,
    url,
  };
}

/**
 * Open the native Gmail app compose screen with the given draft data.
 *
 * Uses the iPhone-verified deep link (googlegmail:///co?...) built by the
 * shared builder, so the recipient, subject and body arrive in the compose
 * screen exactly as stored — Czech diacritics, ampersands and paragraph
 * breaks included.
 *
 * Not-installed guard: right after assigning the app URL we arm a short
 * timer. When iOS hands off to Gmail, this page is hidden and the fallback
 * never fires. If the app is missing or refuses the scheme, the page stays
 * foreground and the operator is sent to web compose instead of a dead end.
 *
 * Navigating here writes nothing and sends nothing.
 */
export function openGmailAppCompose(
  input: GmailComposeInput,
): OpenGmailComposeResult {
  const url = buildGmailAppUrl(input);
  const fallbackUrl = buildGmailComposeUrl(input);

  if (typeof window !== "undefined") {
    window.location.assign(url);

    window.setTimeout(() => {
      if (typeof document !== "undefined" && !document.hidden) {
        window.location.assign(fallbackUrl);
      }
    }, GMAIL_APP_FALLBACK_DELAY_MS);
  }

  return {
    navigated: true,
    url,
    fallbackUrl,
  };
}

/**
 * Open Gmail for a draft on the best platform available.
 *
 * The single entry point for draft "Open in Gmail" actions:
 *   - iOS: the verified native app deep link, with web compose as the
 *     not-installed fallback (see openGmailAppCompose).
 *   - everything else: reliable web compose in the same tab.
 *
 * Never sends, never changes draft status.
 */
export function openGmailComposeSmart(
  input: GmailComposeInput,
): OpenGmailComposeResult {
  if (isIOS()) {
    return openGmailAppCompose(input);
  }
  return openGmailCompose(input);
}

/**
 * Check if the current device is iOS.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || navigator.vendor || "";
  return /iPhone|iPad|iPod/.test(userAgent);
}

/**
 * Check if the current device is Android.
 */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

