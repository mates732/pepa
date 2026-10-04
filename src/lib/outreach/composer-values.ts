/**
 * Composer's editing state, and how it is filled from a STORED message.
 *
 * WHY THIS MODULE EXISTS. Opening a lead from Outreach history used to rebuild
 * the composer in the browser from whatever the history row happened to carry:
 *
 *     setValues({ recipient: row.email, subject: row.latestSubject ?? "",
 *                 body: "", messageId: null, leadId: row.id });
 *
 * Two things were wrong with that, and the second one was invisible until it
 * was diagnosed in a real browser:
 *
 *   * the row exposes the LEAD id, never the message id, so `messageId` was
 *     forced to null — which permanently disabled "Open in Gmail", because the
 *     compose text is read from the stored message. Clicking it fired no
 *     handler at all, so nothing appeared to happen;
 *   * the body was thrown away entirely, so re-opening a saved draft showed an
 *     empty composer and saving it would have overwritten the stored body.
 *
 * The composer is now filled from the message the DATABASE says is that lead's
 * initial outreach, resolved server-side by the existing
 * `loadInitialOutreachDetail` action. This module is the pure seam between that
 * resolved detail and the composer's props: no server-only, no Supabase, no
 * clock, so the mapping is directly testable.
 *
 * The one invariant worth stating out loud: `messageId` here is the id of a row
 * that EXISTS. It is never a guess and never null, which is exactly what the
 * Gmail button and the send-recording path need.
 */

import type { Lead, OutreachMessage } from "@/lib/types";

/**
 * Shape of the composer's controlled state.
 *
 * Declared here and re-exported from `components/email-composer.tsx`, so the
 * dashboard and this mapper can never drift onto two definitions of the same
 * object.
 */
export interface ComposerValues {
  recipient: string;
  subject: string;
  body: string;
  companyName: string;
  contactName: string;
  messageId: string | null;
  /** Set once the draft is saved, so a send can be recorded against its lead. */
  leadId: string | null;
}

/**
 * Fill the composer from a saved message and its lead.
 *
 * Recipient, subject and body all come from the stored row — never from the
 * history row and never from the browser — so "what Gmail receives" and "what
 * PEPA stored" cannot diverge. A stored NULL subject or body becomes an empty
 * string because the composer is a controlled text input, not because the value
 * was lost: an absent subject is still absent from the compose URL, which
 * `buildGmailComposeUrl` omits rather than sending blank.
 *
 * The lead supplies only the two display-name fields and the lead id. It is
 * never a source for the recipient, which stays whatever the message row says.
 */
export function composerValuesFromSavedMessage(detail: {
  lead: Lead;
  message: OutreachMessage;
}): ComposerValues {
  return {
    recipient: detail.message.recipient_email,
    subject: detail.message.subject ?? "",
    body: detail.message.body ?? "",
    companyName: detail.lead.company_name ?? "",
    contactName: detail.lead.contact_name ?? "",
    messageId: detail.message.id,
    leadId: detail.lead.id,
  };
}
