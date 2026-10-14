import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DraftDetailClient } from "./draft-detail-client";

/**
 * Draft detail contract (mark-as-sent affordance).
 *
 * The detail page is reachable from the Drafts list AND from the Follow-ups
 * workspace, so the row may already be sent. The send-recording control must
 * appear only while the message is unsent, and an already-sent message must
 * say so instead of pretending it can be sent again — sent is a database
 * fact, not a client claim.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions", () => ({
  deleteOutreachMessage: vi.fn(async () => ({ ok: true, deleted: true })),
  recordOutreachSent: vi.fn(async () => ({
    ok: true,
    outcome: "recorded",
    nextFollowUpAt: null,
  })),
}));
vi.mock("@/app/update-draft-action", () => ({
  updateDraft: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/load-draft-action", () => ({
  loadDraftById: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/outreach/open-gmail-compose", () => ({
  openGmailComposeSmart: vi.fn(),
}));

type DraftData = Parameters<typeof DraftDetailClient>[0]["initialDraft"];

function draftData(overrides: Partial<DraftData["message"]> = {}): DraftData {
  return {
    ok: true,
    lead: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "info@thearchive.cz",
      company_name: "The Archive",
      contact_name: null,
      status: "ready",
      created_at: "2026-10-01T08:00:00.000Z",
      updated_at: "2026-10-01T08:00:00.000Z",
      last_contacted_at: null,
      next_followup_at: null,
      followup_count: 0,
    },
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
      ...overrides,
    },
  };
}

function buttonsOf(markup: string): string[] {
  return markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

describe("Draft detail — Mark as sent", () => {
  it("offers Mark as sent while the message is unsent", () => {
    const markup = renderToStaticMarkup(
      <DraftDetailClient initialDraft={draftData()} />,
    );

    const mark = buttonsOf(markup).find((b) => b.includes("Mark as sent"));
    expect(mark).toBeDefined();
    expect(mark).not.toContain("disabled");
    expect(mark).toContain("btn-primary");
    expect(markup).toContain(
      "Record that you already sent this email from your own mail client",
    );
  });

  it("never claims PEPA delivered the mail — the Gmail opener stays inert", () => {
    const markup = renderToStaticMarkup(
      <DraftDetailClient initialDraft={draftData()} />,
    );

    expect(markup).toContain("opening Gmail never marks anything as sent");
    expect(markup).toContain(">Open in Gmail<");
  });

  it("replaces the control with an honest Already sent for a sent message", () => {
    const markup = renderToStaticMarkup(
      <DraftDetailClient
        initialDraft={draftData({
          status: "sent",
          sent_at: "2026-10-02T09:00:00.000Z",
        })}
      />,
    );

    const sent = buttonsOf(markup).find((b) => b.includes("Already sent"));
    expect(sent).toBeDefined();
    expect(sent).toContain("disabled");
    expect(markup).not.toContain(">Mark as sent<");
  });

  it("treats a sent status without a timestamp as sent as well", () => {
    const markup = renderToStaticMarkup(
      <DraftDetailClient initialDraft={draftData({ status: "sent" })} />,
    );

    expect(markup).toContain("Already sent");
    expect(markup).not.toContain(">Mark as sent<");
  });
});
