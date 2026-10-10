/**
 * Shared client-side Gmail compose opener.
 *
 * Provides two ways to open Gmail compose:
 *   1. Browser compose (default): navigates to https://mail.google.com/mail/?view=cm&fs=1...
 *      in the same tab. Works on all browsers including iOS Safari.
 *   2. Gmail app (optional): uses a mailto: URL that iOS can handle with the Gmail app
 *      if the user has configured Gmail as their default mail client.
 *
 * WHAT THIS DOES
 *   - Build the Gmail compose URL from draft data the caller already has — no
 *     server round trip.
 *   - For browser compose: navigate using window.location.assign() to avoid popup blocking.
 *   - For Gmail app: return a mailto: URL that the user can choose to open.
 *
 * WHAT THIS DOES NOT DO
 *   - It never sends. The operator presses Send in Gmail; that is the only step
 *     that sends an email.
 *   - It does not guarantee the Gmail app will open. mailto: URLs are handled by
 *     the OS default mail client, which may or may not be the Gmail app.
 *   - It does not promise that iOS will launch the native app. That depends on
 *     iOS/browser configuration.
 */

import { buildComposeUrls, buildMailtoUrl, type GmailComposeInput } from "./gmail-compose";

export interface OpenGmailComposeResult {
  /** Whether browser navigation was attempted (always true for same-tab navigation). */
  navigated: boolean;
  /** The browser compose URL that was navigated to (or would be). */
  url: string;
  /** The mailto: URL that can open the Gmail app on iOS if configured. */
  mailtoUrl: string;
}

export interface OpenGmailComposeOptions {
  /** Whether to attempt Gmail app opening via mailto: (iOS only). */
  tryGmailApp?: boolean;
}

/**
 * Open Gmail compose with the given draft data.
 *
 * By default, navigates to the browser compose URL in the same tab.
 * On iOS, if tryGmailApp is true, also provides a mailto: URL that may
 * open the Gmail app if configured as the default mail client.
 */
export function openGmailCompose(
  input: GmailComposeInput,
  options: OpenGmailComposeOptions = {},
): OpenGmailComposeResult {
  const urls = buildComposeUrls(input);
  const url = urls.web;
  const mailtoUrl = urls.mailto;

  // Browser compose: navigate in same tab to avoid popup blocking.
  if (typeof window !== "undefined") {
    window.location.assign(url);
  }

  return {
    navigated: true,
    url,
    mailtoUrl,
  };
}

/**
 * Build a mailto: URL that may open the Gmail app on iOS.
 *
 * On iOS, if the user has configured Gmail as their default mail client,
 * tapping a mailto: link may open the Gmail app with the compose window
 * pre-filled. This is not guaranteed — it depends on iOS settings.
 */
export function buildGmailAppUrl(input: GmailComposeInput): string {
  return buildMailtoUrl(input);
}

/**
 * Check if the current device is iOS.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent || navigator.vendor || "";
  return /iPad|iPhone|iPod/.test(userAgent) && !/(tablet|pad)/i.test(userAgent);
}