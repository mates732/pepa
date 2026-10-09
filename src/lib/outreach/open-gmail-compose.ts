/**
 * Shared client-side Gmail compose opener.
 *
 * This is the single entry point every active UI component uses to open Gmail.
 * It exists so the six Gmail entry points cannot drift apart: the URL builder,
 * the popup-blocking fallback and the "never claim success" rule live here and
 * nowhere else.
 *
 * WHAT THIS DOES
 *   1. Build the Gmail compose URL from draft data the caller already has — no
 *      server round trip, no about:blank intermediate tab.
 *   2. Call `window.open` synchronously inside the user gesture.
 *   3. If the browser blocks the tab, hand the URL back to the operator
 *      rather than reporting an open Gmail that does not exist.
 *
 * WHAT THIS DOES NOT DO
 *   - It never sends. The operator presses Send in Gmail; that is the only step
 *     that sends an email.
 *   - It never reads the destination. Cross-origin access to the opened tab is
 *     refused, so the tab's actual state is unknown — that is fine, because
 *     PEPA does not need to know whether the operator sent.
 *   - It never opens about:blank as an intermediate destination. The compose
 *     URL goes straight to `window.open`, which keeps the user gesture live
 *     and avoids the blank-tab-then-navigate dance that older code used.
 *
 * POPUP BLOCKING IS NOT DEFINITIVE
 *   `window.open` returning `null` is one signal, but it is not the only one.
 *   Some browsers return a handle and then silently discard the tab; others
 *   block the navigation after returning a handle. This helper therefore treats
 *   a `null` return as "likely blocked" and always surfaces the URL manually,
 *   so the operator can always open the draft themselves.
 */

import { buildComposeUrls, type GmailComposeInput } from "./gmail-compose";

export interface OpenGmailComposeResult {
  opened: boolean;
  url: string;
  message: string;
}

export interface OpenGmailComposeOptions {
  /** Override the window.open implementation (testability). */
  opener?: (url: string, target: string, features: string) => Window | null;
  /** Custom success message. */
  successMessage?: string;
  /** Custom blocked message; the URL is appended automatically. */
  blockedMessage?: string;
}

/**
 * Open a Gmail compose window with the given draft data.
 *
 * The URL is built synchronously from the caller's data. This function is
 * safe to call directly from an onClick handler — it is not async and does
 * not perform any network I/O.
 *
 * Returns a result describing what happened so the caller can display the
 * right feedback.
 */
export function openGmailCompose(
  input: GmailComposeInput,
  options: OpenGmailComposeOptions = {},
): OpenGmailComposeResult {
  const urls = buildComposeUrls(input);
  const url = urls.web;

  const opener = options.opener ?? (typeof window !== "undefined" ? window.open.bind(window) : null);

  if (!opener) {
    return {
      opened: false,
      url,
      message: `${options.blockedMessage ?? "Your browser could not open a new tab."} Open this link manually: ${url}`,
    };
  }

  // Open directly — no about:blank, no noopener (which would make window.open
  // return null even on success), no async wait. The user gesture is live.
  let tab: Window | null;
  try {
    tab = opener(url, "_blank", "noreferrer");
  } catch {
    // Some browsers throw rather than return null on blocked popups.
    tab = null;
  }

  if (!tab) {
    return {
      opened: false,
      url,
      message: `${options.blockedMessage ?? "Your browser blocked the new tab."} Open this link manually: ${url}`,
    };
  }

  // The tab opened. We cannot verify navigation (cross-origin), but we have a
  // valid handle. Null the opener for isolation without noopener semantics.
  try {
    tab.opener = null;
  } catch {
    // Cross-origin handle may refuse; harmless.
  }

  return {
    opened: true,
    url,
    message: options.successMessage ?? `Opened Gmail compose. If it didn't open, use: ${url}`,
  };
}