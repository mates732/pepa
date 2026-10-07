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
 * Build both URLs for a compose action.
 *
 * Returns both `mailto:` (for default mail client) and `web` (Gmail web compose).
 * The caller should try `mailto:` first, then fall back to `web`.
 */
export function buildComposeUrls(input: GmailComposeInput): {
  mailto: string;
  web: string;
} {
  return {
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
export function readComposeParam(url: string, key: string): string | null {
  const query = url.slice(url.indexOf("?") + 1);
  return new URLSearchParams(query).get(key);
}
