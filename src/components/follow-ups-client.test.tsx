import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { formatDate, formatDateTime } from "@/lib/utils/date";
import { FollowUpsClient } from "./follow-ups-client";

/**
 * Workspace rendering contract (workflow spec §3):
 *
 *   * the actionable queue holds due follow-ups only, with Gmail + Mark as sent;
 *   * future follow-ups appear in a separate schedule section with an honest
 *     state — never mixed into the ready-to-send queue, and never offered a
 *     send action before they are due;
 *   * every row carries lead, recipient, sequence label, original send date,
 *     due date and status.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions", () => ({
  loadFollowUps: vi.fn(async () => ({ ok: true, followUps: [] })),
  recordOutreachSent: vi.fn(async () => ({ ok: true, outcome: "recorded" })),
}));
vi.mock("@/lib/outreach/open-gmail-compose", () => ({
  openGmailComposeSmart: vi.fn(),
}));

type Item = Parameters<typeof FollowUpsClient>[0]["initialFollowUps"][number];

function item(overrides: Partial<Item> = {}): Item {
  return {
    message: {
      id: "55555555-5555-5555-5555-555555555555",
      recipient_email: "info@thearchive.cz",
      subject: "Re: AI recepce",
      body: "Navazuji na náš rozhovor.",
      status: "draft",
      sequence_number: 1,
      created_at: "2026-09-29T00:00:00.000Z",
      sent_at: null,
      parent_message_id: "22222222-2222-2222-2222-222222222222",
    },
    lead: {
      id: "11111111-1111-1111-1111-111111111111",
      email: "info@thearchive.cz",
      company_name: "The Archive",
      contact_name: null,
    },
    due: true,
    dueAt: "2026-10-01T08:00:00.000Z",
    initialSentAt: "2026-09-20T09:00:00.000Z",
    initialSent: true,
    attention: 0,
    ...overrides,
  };
}

function scheduled(overrides: Partial<Item> = {}): Item {
  return item({
    due: false,
    dueAt: "2099-01-01T08:00:00.000Z",
    attention: 1,
    ...overrides,
  });
}

function sent(overrides: Partial<Item> = {}): Item {
  return item({
    message: {
      ...item().message,
      id: "66666666-6666-5555-5555-555555555555",
      status: "sent",
      sent_at: "2026-09-30T09:00:00.000Z",
    },
    attention: 2,
    ...overrides,
  });
}

function render(followUps: Item[]): string {
  return renderToStaticMarkup(<FollowUpsClient initialFollowUps={followUps} initialError={null} />);
}

/** The markup of one section, by its heading id. */
function section(markup: string, bucket: "due" | "scheduled" | "sent"): string {
  const start = markup.indexOf(`id="followups-${bucket}-heading"`);
  if (start === -1) return "";
  // Sections are siblings; cut at the next section heading or the end.
  const nextHeading = ["due", "scheduled", "sent"]
    .map((b) => markup.indexOf(`id="followups-${b}-heading"`, start + 1))
    .filter((i) => i !== -1);
  const end = nextHeading.length > 0 ? Math.min(...nextHeading) : markup.length;
  return markup.slice(start, end);
}

describe("Follow-ups workspace — section separation", () => {
  it("counts each section in the header", () => {
    const markup = render([item(), scheduled(), sent()]);
    expect(markup).toContain("1 due · 1 scheduled · 1 sent");
  });

  it("puts the due follow-up in the actionable queue with Gmail and Mark as sent", () => {
    const markup = render([item(), scheduled()]);
    const due = section(markup, "due");

    expect(due).toContain("Due now (1)");
    expect(due).toContain(">Gmail<");
    expect(due).toContain(">Mark as sent<");
  });

  it("keeps future follow-ups out of the actionable queue", () => {
    const markup = render([item(), scheduled()]);
    const due = section(markup, "due");
    const schedule = section(markup, "scheduled");

    expect(schedule).toContain("Scheduled (1)");
    // The due date column shows the schedule, in the app's own formatter.
    expect(schedule).toContain(formatDateTime("2099-01-01T08:00:00.000Z"));
    // No send affordance before a follow-up is due.
    expect(schedule).not.toContain(">Gmail<");
    expect(schedule).not.toContain(">Mark as sent<");
    expect(due).not.toContain(formatDateTime("2099-01-01T08:00:00.000Z"));
  });

  it("shows an inactive follow-up as waiting for the initial send", () => {
    const markup = render([
      scheduled({ dueAt: null, initialSent: false, initialSentAt: null }),
    ]);
    const schedule = section(markup, "scheduled");

    expect(schedule).toContain("Waiting for initial send");
    expect(markup).not.toContain(">Gmail<");
  });

  it("says so plainly when nothing is due", () => {
    const markup = render([scheduled()]);
    expect(markup).toContain("Nothing is due right now.");
  });

  it("separates sent rows into history with no send action", () => {
    const markup = render([sent(), item()]);
    const history = section(markup, "sent");

    expect(history).toContain("Sent (1)");
    expect(history).toContain("chip-success");
    expect(history).not.toContain(">Gmail<");
    expect(history).not.toContain(">Mark as sent<");
  });
});

describe("Follow-ups workspace — required row fields", () => {
  it("renders every column the spec requires", () => {
    const markup = render([item()]);

    for (const header of ["Lead", "Recipient", "Sequence", "Initial sent", "Due", "Status", "Actions"]) {
      expect(markup).toContain(`>${header}<`);
    }
  });

  it("labels the sequence unmistakably and shows both dates", () => {
    const markup = render([item()]);

    expect(markup).toContain("Follow-up #1");
    // Original outreach send date and follow-up due date are both present,
    // rendered by the same formatters the app ships.
    expect(markup).toContain(formatDate(item().initialSentAt));
    expect(markup).toContain(formatDateTime(item().dueAt));
    expect(markup).toContain(item().message.recipient_email);
  });
});
