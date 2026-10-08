import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  OutreachDrafts,
  outreachDraftActionIds,
  outreachDraftSequenceLabel,
} from "@/components/outreach-drafts";
import type { OutreachDraftItem } from "@/components/outreach-drafts";

function draft(overrides: Partial<OutreachDraftItem> = {}): OutreachDraftItem {
  return {
    message: {
      id: "m1",
      lead_id: "l1",
      recipient_email: "info@one.com",
      subject: "Nabídka",
      body: "Body",
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: new Date().toISOString(),
      sequence_number: 0,
      parent_message_id: null,
    },
    lead: {
      id: "l1",
      email: "info@one.com",
      company_name: "Test Barber One",
      contact_name: null,
    },
    ...overrides,
  };
}

describe("outreachDraftSequenceLabel", () => {
  it("formats sequence labels", () => {
    expect(outreachDraftSequenceLabel(0)).toBe("Initial");
    expect(outreachDraftSequenceLabel(1)).toBe("Follow-up #1");
    expect(outreachDraftSequenceLabel(2)).toBe("Follow-up #2");
  });
});

describe("OutreachDrafts", () => {
  it("renders company/contact, recipient, subject and sequence labels", () => {
    const item0 = draft();
    const item1 = draft({
      message: { ...draft().message, id: "m2", sequence_number: 1, subject: "Re: Nabídka" },
      lead: { ...draft().lead, company_name: null, contact_name: "Jan Novák" },
    });
    const item2 = draft({
      message: { ...draft().message, id: "m3", sequence_number: 2, subject: "Re: Nabídka #2" },
    });

    const markup = renderToStaticMarkup(
      <OutreachDrafts
        drafts={[item0, item1, item2]}
        loading={false}
        error={null}
        openingId={null}
        deletingId={null}
        onOpen={vi.fn()}
        onGmail={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(markup).toContain("Drafts (3)");
    expect(markup).toContain("Test Barber One");
    expect(markup).toContain("Jan Novák");
    expect(markup).toContain("info@one.com");
    expect(markup).toContain("Nabídka");
    expect(markup).toContain("Initial");
    expect(markup).toContain("Follow-up #1");
    expect(markup).toContain("Follow-up #2");
  });

  it("maps action ids to message id", () => {
    const ids = outreachDraftActionIds("message-xyz");
    expect(ids.open).toBe("message-xyz");
    expect(ids.gmail).toBe("message-xyz");
    expect(ids.del).toBe("message-xyz");
  });
});
