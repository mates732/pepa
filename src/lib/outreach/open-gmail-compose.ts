/**
 * Shared client-side Gmail compose opener.
 *
 * This is the single entry point every active UI component uses to open Gmail.
 * It exists so the six Gmail entry points cannot drift apart: the URL builder
 * and the "never claim success" rule live here and nowhere else.
 *
 * WHAT THIS DOES
 *   1. Build the Gmail compose URL from draft data the caller already has — no
 *      server round trip.
 *   2. Navigate to the Gmail compose URL in the same tab using window.location.assign().
 *      This avoids popup blocking on iOS Safari and other mobile browsers.
 *   3. The user explicitly clicks the button, so the navigation is a trusted action.
 *
 * WHAT THIS DOES NOT DO
 *   - It never sends. The operator presses Send in Gmail; that is the only step
 *     that sends an email.
 *   - It never reads the destination. Cross-origin access to the opened tab is
 *     refused, so the tab's actual state is unknown — that is fine, because
 *     PEPA does not need to know whether the operator sent.
 *   - It does not promise that the Gmail app will open. That depends on iOS/browser
 *     configuration. We use the standard https://mail.google.com/mail/?view=cm&fs=1...
 *     URL which works in Safari and can be handled by the Gmail app if configured.
 *
 * Note: On iOS Safari, window.open() is blocked by default. Using window.location.assign()
 * performs a same-tab navigation which is not subject to popup blocking. The user sees
 * Gmail open in the same tab and can use the back button to return to PEPA.
 */

import { buildComposeUrls, type GmailComposeInput } from "./gmail-compose";

export interface OpenGmailComposeResult {
  /** Whether navigation was attempted (always true for same-tab navigation). */
  navigated: boolean;
  url: string;
}

export interface OpenGmailComposeOptions {
  /** Custom success message shown before navigation. */
  successMessage?: string;
}

/**
 * Navigate to a Gmail compose URL with the given draft data.
 *
 * The URL is built synchronously from the caller's data. This function is
 * safe to call directly from an onClick handler — it is not async and does
 * not perform any network I/O.
 *
 * Uses window.location.assign() for same-tab navigation, which avoids popup
 * blocking on iOS Safari and other mobile browsers.
 */
export function openGmailCompose(
  input: GmailComposeInput,
  options: OpenGmailComposeOptions = {},
): OpenGmailComposeResult {
  const urls = buildComposeUrls(input);
  const url = urls.web;

  // Use same-tab navigation to avoid popup blocking on mobile browsers.
  // window.location.assign() is not subject to popup blocking rules.
  if (typeof window !== "undefined") {
    window.location.assign(url);
  }

  return {
    navigated: true,
    url,
  };
}