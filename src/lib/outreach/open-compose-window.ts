/**
 * Opening the Gmail compose window without tripping the popup blocker.
 *
 * THE BUG THIS FIXES. Every "Open in Gmail" handler in the dashboard did this:
 *
 *     const result = await openOutreachInGmail(messageId);   // network round trip
 *     window.open(result.url, "_blank", "noopener,noreferrer");
 *
 * The compose URL is server-derived — recipient, subject and body all come from
 * the database — so it cannot exist at click time. But `await` ends the browser's
 * user-gesture chain: by the time `window.open` runs, it is no longer a direct
 * response to the click, so browsers classify it as an unsolicited popup and
 * block it. The handler then reported success ("Gmail opened with the saved
 * text") for a tab that never appeared. Silent, and worse than an error, because
 * the operator was told it had worked.
 *
 * THE FIX. Open a blank tab synchronously, during the click, while the gesture is
 * still live, then navigate that same tab to the compose URL once the server
 * answers. The tab is real from the user's point of view — it simply arrives
 * before the content.
 *
 * One subtlety: `noopener` cannot be passed here. Per spec, `window.open` with
 * `noopener` returns `null`, which would discard the only handle we have. The
 * opener is therefore nulled on the returned handle instead, which achieves the
 * same isolation (the destination cannot reach back into PEPA) while keeping the
 * reference. The destination is a fixed `mail.google.com` origin built by
 * `buildGmailComposeUrl`; no user-controlled URL is ever navigated to here.
 *
 * No OAuth, no Gmail API, no token, no network from this module. It only manages
 * a browser window; the URL still comes from the existing Phase 4B action.
 */

/** Minimal handle this module needs, so tests can supply a fake. */
export interface ComposeWindowHandle {
  location: { href: string };
  closed: boolean;
  close: () => void;
  opener: unknown;
}

/** Opens a tab synchronously. Injectable so the behaviour is testable in Node. */
export type WindowOpener = (url: string, target?: string) => ComposeWindowHandle | null;

const defaultOpener: WindowOpener = (url, target) =>
  typeof window === "undefined" ? null : (window.open(url, target) as ComposeWindowHandle | null);

/**
 * Reserve the tab while the user gesture is still active.
 *
 * Returns `null` when the browser refused even this, which the caller must treat
 * as "fall back", not as success.
 */
export function preopenComposeWindow(open: WindowOpener = defaultOpener): ComposeWindowHandle | null {
  const handle = open("about:blank", "_blank");
  if (!handle) return null;
  // Isolation without `noopener`, which would have made `open` return null.
  try {
    handle.opener = null;
  } catch {
    // A cross-origin handle can refuse the assignment; harmless, since the
    // navigation below immediately replaces the document.
  }
  return handle;
}

/**
 * Send the reserved tab to the compose URL.
 *
 * Returns `false` when there is no usable tab, so the caller can surface the URL
 * instead of silently doing nothing.
 */
export function navigateComposeWindow(handle: ComposeWindowHandle | null, url: string): boolean {
  if (!handle || handle.closed) return false;
  handle.location.href = url;
  return true;
}

/** Close the reserved tab when the compose URL could not be produced. */
export function closeComposeWindow(handle: ComposeWindowHandle | null): void {
  if (!handle || handle.closed) return;
  try {
    handle.close();
  } catch {
    // Already gone.
  }
}
