/**
 * Gmail compose URL builder.
 *
 * This is NOT a Gmail integration. It is a pure string builder: no OAuth, no API
 * call, no token, no network. PEPA produces a `mailto:`-style compose URL and the
 * operator's browser opens Gmail with the draft pre-filled. PEPA never learns
 * whether — or whether at all — that email was ever sent. Only the explicit
 * "Mark as sent" action records a send.
 *
 * Pure leaf module on purpose: no Supabase, no server-only, no clock. Everything
 * is a function of its arguments, so the encoding rules can be tested directly.
 */

/**
 * Compose endpoint. `fs=1` opens the full compose window; `view=cm` is the
 * compose view. No tracking parameters and no account state are ever added.
 */
const GMAIL_COMPOSE_ORIGIN = "https://mail.google.com/mail/";

export interface GmailComposeInput {
  /** Recipient address. Copied from the database, never from the client. */
  to: string;
  subject?: string | null;
  body?: string | null;
}

/**
 * Build a Gmail web compose URL.
 *
 * Encoding is delegated entirely to `URLSearchParams`. Hand-rolled concatenation
 * is the classic way this goes wrong: an `&` in a subject silently splits the URL
 * into a new parameter, and a `+` in an address decodes as a space. `URLSearchParams`
 * handles spaces, `+`, `@`, `&`, `?`, newlines, Czech diacritics, apostrophes and
 * quotation marks correctly, and round-trips the original text exactly.
 *
 * Absent subject or body is omitted rather than sent as an empty parameter, so
 * Gmail opens with a clean draft rather than an empty line.
 */
export function buildGmailComposeUrl(input: GmailComposeInput): string {
  const params = new URLSearchParams();
  params.set("view", "cm");
  params.set("fs", "1");
  params.set("to", (input.to ?? "").trim());

  const subject = (input.subject ?? "").trim();
  if (subject) params.set("su", subject);

  // The body is only trimmed for emptiness; the value itself is preserved byte
  // for byte, so indentation and intentional blank lines survive the round trip.
  const body = input.body ?? "";
  if (body.trim()) params.set("body", body);

  // `params.toString()` percent-encodes using application/x-www-form-urlencoded,
  // which is what Gmail's compose endpoint expects.
  return `${GMAIL_COMPOSE_ORIGIN}?${params.toString()}`;
}

/**
 * Build a `mailto:` URL for the system default mail client.
 *
 * This is the standard way to open the user's configured email application
 * (Gmail PWA, Outlook, Apple Mail, Thunderbird, etc.). If the user has set
 * Gmail as their default mail handler in OS settings, this opens Gmail.
 *
 * `mailto:` has some limitations compared to Gmail web:
 * - URL length limits in some clients (~2000 chars)
 * - Not all clients support the `body` parameter reliably
 * - Line endings should be CRLF per RFC 6068
 *
 * We still include subject and body for clients that support them.
 */
export function buildMailtoUrl(input: GmailComposeInput): string {
  const params = new URLSearchParams();
  const to = (input.to ?? "").trim();
  if (to) params.set("to", to);

  const subject = (input.subject ?? "").trim();
  if (subject) params.set("subject", subject);

  // Per RFC 6068, body should use CRLF line endings
  const body = input.body ?? "";
  if (body.trim()) {
    params.set("body", body.replace(/\n/g, "\r\n"));
  }

  return `mailto:${to ? `?${params.toString()}` : ""}`;
}

/**
 * Verified Gmail iOS **app** compose base URL.
 *
 * Note the THREE slashes: `googlegmail:///co?`. This exact form was confirmed
 * on the operator's real iPhone to open the native Gmail app directly into a
 * compose screen prefilled with to/subject/body. The two-slash form
 * (`googlegmail://co?`) that previously shipped here did not open compose and
 * was the root cause of drafts only ever reaching Gmail-in-Safari.
 *
 * Google does not officially document any iOS URL scheme — this is
 * community-reported behavior, verified on our device, and could change in a
 * future Gmail release.
 */
export const GMAIL_APP_COMPOSE_BASE = "googlegmail:///co?";

/**
 * Build a Gmail app deep link URL for iOS/Android.
 *
 * Produces the exact construction verified on the operator's iPhone:
 * `googlegmail:///co?to=...&subject=...&body=...` with all three parameters
 * always present, in that order. Encoding is percent-encoding (RFC 3986):
 * spaces as `%20`, newlines as `%0A`, Czech diacritics and `&`
 * percent-encoded. The body is preserved byte for byte — no newline
 * normalization — so what the operator sees in the Gmail compose screen is
 * exactly what PEPA stored.
 *
 * WHY NOT URLSearchParams.toString() OUTPUT VERBATIM: it serializes as
 * application/x-www-form-urlencoded, where a space becomes `+`. Gmail's web
 * compose endpoint decodes `+` as a space, but the native iOS app's
 * `googlegmail:///co` handler does not — real-device testing showed the
 * compose screen displaying `Dobrý+den,` instead of `Dobrý den,`. The app
 * scheme expects plain RFC 3986 percent-encoding, so spaces are re-encoded
 * as `%20` after serialization. This is safe: URLSearchParams already
 * encodes a literal `+` in the content as `%2B`, so every `+` remaining in
 * the serialized query is a space marker and nothing else — genuine plus
 * signs survive as `%2B` and are decoded back to `+` by the Gmail app.
 *
 * The recipient is trimmed; a null/absent subject or body becomes an empty
 * parameter rather than being omitted, matching the verified URL shape.
 *
 * This is NOT guaranteed to work forever: the Gmail app must be installed,
 * iOS may show a picker dialog, and the scheme may change between versions.
 * Callers should keep the web compose URL (`buildGmailComposeUrl`) as the
 * fallback — see `openGmailAppCompose`, which wires that fallback in.
 *
 * Nothing here sends. Gmail opens a compose screen; the operator presses Send.
 */
export function buildGmailAppUrl(input: GmailComposeInput): string {
  const params = new URLSearchParams();
  params.set("to", (input.to ?? "").trim());
  params.set("subject", (input.subject ?? "").trim());
  // The body is preserved byte for byte; URLSearchParams encodes newlines as %0A.
  params.set("body", input.body ?? "");

  // URLSearchParams serializes spaces as `+` (application/x-www-form-urlencoded),
  // which the native Gmail app prints literally (`Dobrý+den,`). Re-encode space
  // markers as %20 for the app scheme. URLSearchParams already emits genuine
  // `+` characters as `%2B`, so this replacement touches ONLY space markers.
  const query = params.toString().replace(/\+/g, "%20");

  return `${GMAIL_APP_COMPOSE_BASE}${query}`;
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
 * Build all compose URLs for a draft.
 *
 * Returns:
 *   - gmailApp: verified googlegmail:///co? app deep link (best-effort)
 *   - mailto: mailto: URL as another fallback
 *   - web: Gmail web compose URL as reliable fallback
 */
export function buildComposeUrls(input: GmailComposeInput): {
  gmailApp: string;
  mailto: string;
  web: string;
} {
  return {
    gmailApp: buildGmailAppUrl(input),
    mailto: buildMailtoUrl(input),
    web: buildGmailComposeUrl(input),
  };
}

/**
 * Read one parameter back out of a compose URL.
 *
 * Exists so the round trip is testable: "what the operator sees in Gmail" must
 * equal "what PEPA stored". Kept here rather than in a test so the two can never
 * drift apart.
 */
export function readComposeParam(url: string | undefined | null, key: string): string | null {
  if (!url) return null;
  const query = url.slice(url.indexOf("?") + 1);
  return new URLSearchParams(query).get(key);
}
