/**
 * Shared client-side Gmail compose opener.
 *
 * Provides three ways to open Gmail compose:
 *   1. Browser compose (default): navigates to https://mail.google.com/mail/?view=cm&fs=1...
 *      in the same tab. Works on all browsers including iOS Safari.
 *   2. Gmail app (iOS/Android): uses googlegmail:// URL scheme to try opening the
 *      Gmail app directly. Best-effort — not guaranteed across all Gmail versions.
 *   3. mailto: fallback: standard mailto: URL as another fallback option.
 *
 * WHAT THIS DOES
 *   - Build the Gmail compose URL from draft data the caller already has — no
 *     server round trip.
 *   - For browser compose: navigate using window.location.assign() to avoid popup blocking.
 *   - For Gmail app: use googlegmail:// URL scheme (best-effort).
 *
 * WHAT THIS DOES NOT DO
 *   - It never sends. The operator presses Send in Gmail; that is the only step
 *     that sends an email.
 *   - It does not guarantee the Gmail app will open via googlegmail://. The scheme
 *     may not work on all Gmail versions, and iOS may show a picker dialog.
 *   - It does not promise that iOS will launch the native app.
 */

import { buildComposeUrls, type GmailComposeInput } from "./gmail-compose";

export interface OpenGmailComposeResult {
  /** Whether browser navigation was attempted (always true for same-tab navigation). */
  navigated: boolean;
  /** The browser compose URL (https://mail.google.com/mail/?view=cm&fs=1...). */
  url: string;
}

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

