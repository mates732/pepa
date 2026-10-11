/**
 * Builder for the Gmail iOS **app** compose scheme.
 *
 * `googlegmail:///co?...` is community-reported only — Google does not
 * officially document any URL scheme for the iOS Gmail app — but the plain
 * `googlegmail://` launcher has now been confirmed working on the user's
 * iPhone, so this is the next diagnostic step: same scheme family, plus the
 * commonly reported `co` (compose) route with to/subject/body.
 *
 * Encoding is done with URLSearchParams so Czech diacritics, ampersands,
 * plus signs and multiline bodies survive exactly as on the web compose URL.
 * Nothing here sends email — Gmail opens a compose screen and the operator
 * still presses Send.
 */

export const GMAIL_APP_COMPOSE_BASE = "googlegmail:///co?";

export interface GmailAppComposeInput {
  to: string;
  subject: string;
  body: string;
}

export function buildGmailAppComposeUrl(input: GmailAppComposeInput): string {
  const params = new URLSearchParams();
  params.set("to", input.to.trim());
  params.set("subject", input.subject);
  params.set("body", input.body);
  return `${GMAIL_APP_COMPOSE_BASE}${params.toString()}`;
}
