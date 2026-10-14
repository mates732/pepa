import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DraftsListClient } from "./drafts-list-client";

/**
 * Drafts list contract (mark-as-sent affordance).
 *
 * PEPA sends no mail: the operator sends the draft from their own client and
 * records the fact here, so every unsent row must offer "Mark as sent" next to
 * the (inert) Gmail opener. The button must never claim that PEPA delivered
 * anything, and it must stay disabled while any recording is in flight.
 *
 * The runtime behavior of the transition itself — the compare-and-set, the
 * quality gate, idempotency — is covered by the service tests
 * (`outreach-service.record-sent.test.ts`) and the workspace test
 * (`follow-ups-client.test.tsx`); these assertions pin the reachable control
 * and its wording.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions", () => ({
  deleteOutreachMessage: vi.fn(async () => ({ ok: true, deleted: true })),
  loadOutreachDraftRows: vi.fn(async () => ({ ok: true, drafts: [] })),
  recordOutreachSent: vi.fn(async () => ({
    ok: true,
    outcome: "recorded",
    nextFollowUpAt: null,
  })),
}));
vi.mock("@/lib/outreach/open-gmail-compose", () => ({
  openGmailComposeSmart: vi.fn(),
}));

type Draft = Parameters<typeof DraftsListClient>[0]["initialDrafts"][number];

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    message: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lead_id: "11111111-1111-4111-8111-111111111111",
      recipient_email: "info@thearchive.cz",
      subject: "Nabídka automatizace",
      body: "Dobrý den,",
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-10-01T08:00:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
    },
    lead: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "info@thearchive.cz",
      company_name: "The Archive",
      contact_name: null,
    },
    ...overrides,
  };
}

function buttonsOf(markup: string): string[] {
  return markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

describe("Drafts list — Mark as sent", () => {
  it("offers Mark as sent on every unsent row, beside Gmail", () => {
    const markup = renderToStaticMarkup(
      <DraftsListClient initialDrafts={[draft(), draft({ message: { ...draft().message, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "ready" } })]} initialError={null} />,
    );

    const markButtons = buttonsOf(markup).filter((b) => b.includes("Mark as sent"));
    expect(markButtons).toHaveLength(2);
    // One per row, enabled: the rows are unsent by construction.
    for (const button of markButtons) {
      expect(button).not.toContain("disabled");
    }
    expect(markup).toContain(">Gmail<");
  });

  it("keeps the row's other actions available and marks the send-recording one as primary", () => {
    const markup = renderToStaticMarkup(
      <DraftsListClient initialDrafts={[draft()]} initialError={null} />,
    );

    const gmail = buttonsOf(markup).find((b) => b.includes(">Gmail<"));
    const mark = buttonsOf(markup).find((b) => b.includes("Mark as sent"));
    const del = buttonsOf(markup).find((b) => b.includes(">Del<"));

    expect(gmail).toBeDefined();
    expect(mark).toBeDefined();
    expect(del).toBeDefined();
    expect(mark).toContain("btn-primary");
  });

  it("states in the tooltip that opening Gmail never marks a send", () => {
    const markup = renderToStaticMarkup(
      <DraftsListClient initialDrafts={[draft()]} initialError={null} />,
    );

    expect(markup).toContain(
      "Record that you already sent this email from your own mail client",
    );
    expect(markup).toContain("opening Gmail never marks anything as sent");
  });

  it("explains the flow in the header without promising that PEPA sends mail", () => {
    const markup = renderToStaticMarkup(
      <DraftsListClient initialDrafts={[draft()]} initialError={null} />,
    );

    expect(markup).toContain("Send it from your own mail client");
    expect(markup).toContain("never marks anything as sent");
  });

  it("still renders without drafts", () => {
    const markup = renderToStaticMarkup(
      <DraftsListClient initialDrafts={[]} initialError={null} />,
    );

    expect(markup).toContain("No drafts yet.");
  });
});
