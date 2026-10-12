/**
 * Shared client-side Gmail compose opener.
 *
 * The ONE place draft entry points open Gmail. Three openers:
 *   1. openGmailCompose: web compose (https://mail.google.com/mail/?view=cm&fs=1...)
 *      in the same tab. Reliable on all platforms including iOS Safari.
 *   2. openGmailAppCompose: the iPhone-verified native app deep link
 *      (googlegmail:///co?to=...&subject=...&body=...) triggered WITHOUT
 *      navigating the current tab — Pepa stays loaded. If the app does not
 *      open, a MANUAL fallback banner is offered; nothing redirects the tab.
 *   3. openGmailComposeSmart: platform-aware wrapper — on iOS it opens the
 *      native app (verified on the operator's device), everywhere else it
 *      opens web compose. This is what the draft entry points call.
 *
 * WHAT THIS DOES
 *   - Build the Gmail compose URL from draft data the caller already has — no
 *     server round trip.
 *   - Web compose: navigate with window.location.assign() (same tab).
 *   - Native app: click a temporary hidden anchor carrying the deep link. iOS
 *     hands it to the Gmail app exactly like a tapped link, while the Pepa
 *     tab keeps its URL, scroll position and unsaved UI state — returning
 *     from Gmail lands the operator exactly where they left off.
 *
 * WHAT THIS DOES NOT DO
 *   - It never sends. The operator presses Send in Gmail; that is the only
 *     step that sends an email.
 *   - It writes nothing. Opening a draft never changes its status; only the
 *     explicit "Mark as sent" action records a send.
 *   - It never assigns a Gmail URL to window.location on the app path, and it
 *     never auto-navigates the Pepa tab to mail.google.com. (An earlier
 *     version armed a web-compose fallback timer after assigning the deep
 *     link with window.location.assign. Two bugs: the assign replaced Pepa in
 *     the tab, and iOS suspends — not cancels — timers while backgrounded, so
 *     the "did the app open?" timer resumed and fired the moment the operator
 *     RETURNED from Gmail, replacing Pepa with mail.google.com. The fallback
 *     is now a manual banner and is permanently suppressed once the page has
 *     been backgrounded.)
 *   - It does not guarantee the Gmail app will open. The scheme is
 *     community-reported (not officially documented by Google) and the app
 *     must be installed.
 */

import {
  buildComposeUrls,
  buildGmailAppUrl,
  buildGmailComposeUrl,
  type GmailComposeInput,
} from "./gmail-compose";

export interface OpenGmailComposeResult {
  /**
   * Whether a Gmail hand-off was triggered (always true when a window
   * exists — same-tab navigation for web compose, deep-link click for the app).
   */
  navigated: boolean;
  /** The URL that was (or would be) used for the hand-off. */
  url: string;
  /**
   * Web compose URL offered by the MANUAL fallback. Only set on the app
   * deep-link path; it is never assigned to the tab automatically.
   */
  fallbackUrl?: string;
}

/**
 * How long to wait before concluding the Gmail app did not open. Matches the
 * delay proven on the /gmail test bench (GmailAppLink) on the real iPhone.
 */
export const GMAIL_APP_FALLBACK_DELAY_MS = 1500;

/** Id of the manual fallback banner. Exported for tests. */
export const GMAIL_FALLBACK_BANNER_ID = "pepa-gmail-web-fallback";

/**
 * Open Gmail compose with the given draft data.
 *
 * Navigates to the browser compose URL in the same tab. This is the reliable
 * default that works on all platforms — and the explicit "Open Gmail on the
 * web" action on mobile. It is only ever triggered by an operator click.
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
 * The Pepa tab is deliberately NOT navigated: the deep link fires from a
 * temporary hidden anchor (see triggerAppSchemeWithoutNavigating), so the
 * operator's page, scroll position and unsaved state survive the round trip
 * to Gmail and back.
 *
 * Opens nothing, writes nothing and sends nothing.
 */
export function openGmailAppCompose(
  input: GmailComposeInput,
): OpenGmailComposeResult {
  const url = buildGmailAppUrl(input);
  const fallbackUrl = buildGmailComposeUrl(input);

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    triggerAppSchemeWithoutNavigating(url);
    armManualWebFallback(fallbackUrl);
  }

  return {
    navigated: true,
    url,
    fallbackUrl,
  };
}

/**
 * Fire the deep link from a temporary hidden anchor.
 *
 * Deliberately NOT window.location.assign: assigning would replace the Pepa
 * tab's own location, so returning from Gmail could land the operator on the
 * Gmail scheme or on mail.google.com instead of Pepa. A clicked anchor with a
 * custom scheme is handed to iOS exactly like a tapped link — the pattern the
 * /gmail bench verified on the real device — while the page stays where it is.
 */
function triggerAppSchemeWithoutNavigating(url: string): void {
  if (!document.body) return;

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  anchor.setAttribute("aria-hidden", "true");
  anchor.style.position = "fixed";
  anchor.style.left = "-9999px";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Arm a MANUAL web fallback for the case the Gmail app does not open.
 *
 * Never navigates on its own. If the page was never backgrounded within the
 * hand-off window, a small banner appears offering "Otevřít Gmail na webu" —
 * following it is an explicit operator click, not an automatic redirect.
 *
 * The background latch is the critical part. While the page is backgrounded
 * its timers are suspended, not cancelled, so a naive "still visible?" timer
 * runs when the operator RETURNS from Gmail — by then document.hidden is
 * false again, and the old version navigated the Pepa tab to mail.google.com
 * at exactly that moment. Once the page has been hidden at least once (i.e.
 * iOS did hand off to an app), this fallback path is permanently suppressed
 * for that attempt.
 *
 * The latch logic is unit-tested with a stubbed document; real iOS
 * lifecycle behavior still requires a device check.
 */
export function armManualWebFallback(fallbackUrl: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  let wasHidden = false;
  const onVisibilityChange = () => {
    if (document.hidden) wasHidden = true;
  };
  document.addEventListener("visibilitychange", onVisibilityChange, true);

  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onVisibilityChange, true);

    if (wasHidden || document.hidden) return;

    showManualWebFallback(fallbackUrl);
  }, GMAIL_APP_FALLBACK_DELAY_MS);
}

/**
 * Show the manual fallback banner: an offer, never a navigation. The Pepa
 * page stays exactly as it is; the operator chooses to continue on the web
 * (explicit click on the link) or dismisses the banner.
 */
function showManualWebFallback(fallbackUrl: string): void {
  if (document.getElementById(GMAIL_FALLBACK_BANNER_ID)) return;

  const banner = document.createElement("div");
  banner.id = GMAIL_FALLBACK_BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;" +
    "background:#111827;color:#fff;border-radius:12px;padding:14px 16px;" +
    "font:14px/1.45 system-ui,-apple-system,sans-serif;" +
    "box-shadow:0 6px 24px rgba(0,0,0,0.35);display:flex;flex-direction:column;gap:10px;";

  const message = document.createElement("p");
  message.style.cssText = "margin:0;";
  message.textContent =
    "Aplikaci Gmail se nepodařilo otevřít. Zůstáváte v Pepě — můžete pokračovat na webu.";

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:center;";

  const webLink = document.createElement("a");
  webLink.href = fallbackUrl;
  webLink.textContent = "Otevřít Gmail na webu";
  webLink.style.cssText =
    "display:inline-block;background:#fff;color:#111827;border-radius:8px;" +
    "padding:8px 14px;font-weight:600;text-decoration:none;";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Zavřít";
  dismiss.style.cssText =
    "display:inline-block;background:transparent;color:#fff;border:1px solid #6b7280;" +
    "border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;";
  dismiss.addEventListener("click", () => banner.remove());

  actions.appendChild(webLink);
  actions.appendChild(dismiss);
  banner.appendChild(message);
  banner.appendChild(actions);
  document.body.appendChild(banner);
}

/**
 * Open Gmail for a draft on the best platform available.
 *
 * The single entry point for draft "Open in Gmail" actions:
 *   - iOS: the verified native app deep link, triggered without navigating
 *     the Pepa tab, with a manual (never automatic) web fallback — see
 *     openGmailAppCompose.
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
