/**
 * Builder for the Gmail iOS **app** compose scheme.
 *
 * This module used to own its own copy of the `googlegmail:///co?...`
 * construction. That construction was confirmed working on the user's
 * iPhone, so it has since been promoted to the shared outreach library
 * (`src/lib/outreach/gmail-compose.ts`, `buildGmailAppUrl`) and this module
 * now re-exports it. The /gmail diagnostic page and every production draft
 * entry point therefore build the identical URL and can never drift apart.
 *
 * `googlegmail:///co?...` (three slashes) is community-reported only —
 * Google does not officially document any URL scheme for the iOS Gmail
 * app — but this exact form opens the native app into a prefilled compose
 * screen on the operator's device.
 *
 * Encoding is done with URLSearchParams so Czech diacritics, ampersands,
 * plus signs and multiline bodies survive exactly as on the web compose URL.
 * Nothing here sends email — Gmail opens a compose screen and the operator
 * still presses Send.
 */

import {
  GMAIL_APP_COMPOSE_BASE,
  buildGmailAppUrl,
  type GmailComposeInput,
} from "@/lib/outreach/gmail-compose";

export { GMAIL_APP_COMPOSE_BASE };

/** Input shape kept for existing callers: recipient plus optional fields. */
export type GmailAppComposeInput = GmailComposeInput;

/** The shared, iPhone-verified app compose builder (single source of truth). */
export const buildGmailAppComposeUrl = buildGmailAppUrl;
