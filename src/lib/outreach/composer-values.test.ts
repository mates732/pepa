import { describe, expect, it } from "vitest";

import { composerValuesFromSavedMessage } from "./composer-values";
import type { Lead, OutreachMessage } from "@/lib/types";

/**
 * The composer is filled from a STORED message.
 *
 * This mapper is the seam that replaced a browser-side reconstruction from the
 * Outreach-history row. Two properties carry the whole fix:
 *
 *   * `messageId` is the id of a row that exists — never null, never a guess.
 *     That is what makes "Open in Gmail" reachable: the button is disabled
 *     without it, because the compose text is read from the stored message.
 *   * recipient, subject and body come from the MESSAGE row, not from the lead
 *     and not from the history row. An absent subject or body must survive as an
 *     empty string rather than silently becoming something else.
 */

function message(overrides: Partial<OutreachMessage> = {}): OutreachMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    lead_id: "22222222-2222-4222-8222-222222222222",
    recipient_email: "katy@beautysalon.cz",
    subject: "AI recepce pro Beautysalon v Průhonicích",
    body: "Dobrý den, paní Klimentová,\n\nDěláme AI recepci.\n\nDíky, Pavel",
    status: "draft",
    provider: null,
    provider_message_id: null,
    sent_at: null,
    created_at: "2026-10-04T00:00:00.000Z",
    sequence_number: 0,
    parent_message_id: null,
    ...overrides,
  } as OutreachMessage;
}

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    email: "katy@beautysalon.cz",
    company_name: "Beautysalon",
    contact_name: "Kateřina Klimentová",
    status: "draft",
    created_at: "2026-10-04T00:00:00.000Z",
    updated_at: "2026-10-04T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
    ...overrides,
  } as Lead;
}

describe("composerValuesFromSavedMessage", () => {
  it("carries the stored message id, so the Gmail button is reachable", () => {
    const values = composerValuesFromSavedMessage({ lead: lead(), message: message() });

    // The single regression this whole fix exists for.
    expect(values.messageId).toBe("11111111-1111-4111-8111-111111111111");
    expect(values.leadId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("preserves the saved recipient, subject and body exactly", () => {
    const values = composerValuesFromSavedMessage({ lead: lead(), message: message() });

    expect(values.recipient).toBe("katy@beautysalon.cz");
    expect(values.subject).toBe("AI recepce pro Beautysalon v Průhonicích");
    // Byte for byte, newlines included: the body is the message, not a summary.
    expect(values.body).toBe(
      "Dobrý den, paní Klimentová,\n\nDěláme AI recepci.\n\nDíky, Pavel",
    );
  });

  it("takes the recipient from the message, never from the lead", () => {
    // The two can disagree — a lead is keyed on one address, a message on the
    // address it was actually addressed to. Gmail must get the message's.
    const values = composerValuesFromSavedMessage({
      lead: lead({ email: "old-address@example.com" }),
      message: message({ recipient_email: "katy@beautysalon.cz" }),
    });

    expect(values.recipient).toBe("katy@beautysalon.cz");
  });

  it("carries the lead's display context", () => {
    const values = composerValuesFromSavedMessage({ lead: lead(), message: message() });

    expect(values.companyName).toBe("Beautysalon");
    expect(values.contactName).toBe("Kateřina Klimentová");
  });

  it("turns absent display names into empty strings, not the string null", () => {
    const values = composerValuesFromSavedMessage({
      lead: lead({ company_name: null, contact_name: null }),
      message: message(),
    });

    expect(values.companyName).toBe("");
    expect(values.contactName).toBe("");
  });

  it("leaves an absent subject or body empty rather than inventing content", () => {
    const values = composerValuesFromSavedMessage({
      lead: lead(),
      message: message({ subject: null, body: null }),
    });

    expect(values.subject).toBe("");
    expect(values.body).toBe("");
    // Still a real stored row, so the Gmail control remains available.
    expect(values.messageId).not.toBeNull();
  });

  it("follows a follow-up message rather than assuming sequence 0", () => {
    const values = composerValuesFromSavedMessage({
      lead: lead(),
      message: message({
        id: "33333333-3333-4333-8333-333333333333",
        subject: "Re: AI recepce pro Beautysalon v Průhonicích",
        sequence_number: 1,
        parent_message_id: "11111111-1111-4111-8111-111111111111",
      }),
    });

    expect(values.messageId).toBe("33333333-3333-4333-8333-333333333333");
    expect(values.subject).toBe("Re: AI recepce pro Beautysalon v Průhonicích");
  });
});
