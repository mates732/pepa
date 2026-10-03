import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OutreachActivity } from "@/components/outreach-activity";
import { OutreachActivityDetail } from "@/components/outreach-activity-detail";
import type {
  OutreachActivityDetail as DetailData,
  OutreachActivityItem,
} from "@/lib/services/outreach-activity-service";

/**
 * Activity surface tests.
 *
 * Two properties are pinned here, both of which are easier to break in markup
 * than in code:
 *
 *   1. the empty state says "no outreach sent yet" rather than "no activity",
 *      because drafts and unsent follow-ups can exist while this list is empty;
 *   2. Activity offers no mutation control at all — a "mark unsent", delete or
 *      edit affordance appearing here would be a regression in the audit
 *      surface, not a feature.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component test, so
 * no new UI framework or DOM environment is introduced.
 */

const ARCHIVE = "11111111-1111-1111-1111-111111111111";

function item(overrides: Partial<OutreachActivityItem> = {}): OutreachActivityItem {
  const sequenceNumber = overrides.message?.sequence_number ?? 0;
  return {
    message: {
      id: "11111111-1111-1111-1111-111111111112",
      lead_id: ARCHIVE,
      recipient_email: "info@thearchive.cz",
      subject: "Nabídka pro The Archive",
      body: "Dobrý den.",
      status: "sent",
      provider: null,
      provider_message_id: null,
      sent_at: "2026-10-03T09:14:00.000Z",
      created_at: "2026-10-03T08:00:00.000Z",
      sequence_number: sequenceNumber,
      parent_message_id: null,
      ...(overrides.message ?? {}),
    },
    lead: {
      id: ARCHIVE,
      email: "info@thearchive.cz",
      company_name: "The Archive",
      contact_name: null,
    },
    typeLabel: sequenceNumber === 0 ? "Initial outreach" : `Follow-up #${sequenceNumber}`,
    ...overrides,
  } as OutreachActivityItem;
}

function renderList(activity: OutreachActivityItem[], overrides: Partial<React.ComponentProps<typeof OutreachActivity>> = {}) {
  const props: React.ComponentProps<typeof OutreachActivity> = {
    activity,
    onSelect: () => {},
    loading: false,
    error: null,
    selectedId: null,
    truncated: false,
    limit: 100,
    ...overrides,
  };

  return renderToStaticMarkup(<OutreachActivity {...props} />);
}

function renderDetail(detail: Partial<DetailData> = {}) {
  const base: DetailData = {
    message: item().message,
    lead: item().lead,
    parent: null,
    initial: item().message,
    isInitial: true,
    typeLabel: "Initial outreach",
    ...detail,
  };

  const props: React.ComponentProps<typeof OutreachActivityDetail> = {
    detail: base,
    onClose: () => {},
    onOpenInGmail: () => {},
    openingGmail: false,
    notice: null,
  };

  return renderToStaticMarkup(<OutreachActivityDetail {...props} />);
}

describe("OutreachActivity list", () => {
  it("says no outreach has been sent yet when the list is empty", () => {
    const markup = renderList([]);

    expect(markup).toContain("No outreach sent yet");
    // "No activity exists" would be false: unsent drafts and follow-ups may
    // well exist, they simply are not activity.
    expect(markup).not.toContain("No activity exists");
  });

  it("renders one row per sent message with time, name, type and recipient", () => {
    const markup = renderList([
      item(),
      item({
        message: {
          ...item().message,
          id: "22222222-2222-2222-2222-222222222222",
          sequence_number: 1,
          sent_at: "2026-10-03T11:32:00.000Z",
          subject: "Just following up",
        },
        typeLabel: "Follow-up #1",
      }),
    ]);

    expect(markup).toContain("The Archive");
    expect(markup).toContain("info@thearchive.cz");
    expect(markup).toContain("Initial outreach");
    expect(markup).toContain("Follow-up #1");
    expect(markup).toContain("Just following up");
  });

  it("exposes no control that could change recorded outreach", () => {
    const markup = renderList([item()]);

    expect(markup).not.toMatch(/mark unsent/i);
    expect(markup).not.toMatch(/delete/i);
    expect(markup).not.toMatch(/edit/i);
  });

  it("admits when the window is limited rather than implying a full history", () => {
    expect(renderList([item()], { truncated: true, limit: 100 })).toContain(
      "Showing the 100 most recent sends",
    );
  });

  it("surfaces a load error instead of an empty list", () => {
    const markup = renderList([], { error: "Activity could not be loaded." });

    expect(markup).toContain("Activity could not be loaded.");
    expect(markup).not.toContain("No outreach sent yet");
  });
});

describe("OutreachActivityDetail", () => {
  it("shows the exact stored outreach", () => {
    const markup = renderDetail();

    expect(markup).toContain("info@thearchive.cz");
    expect(markup).toContain("Nabídka pro The Archive");
    expect(markup).toContain("Dobrý den.");
    expect(markup).toContain("Initial outreach");
  });

  it("offers only the read-only Gmail hand-off", () => {
    const markup = renderDetail();

    expect(markup).toContain("Open in Gmail");
    // No record-send control here: the send was already recorded, and Activity
    // is not a place where that can change.
    expect(markup).not.toMatch(/mark as sent/i);
    expect(markup).not.toMatch(/mark unsent/i);
    expect(markup).toContain("Activity cannot change it");
  });

  it("names a removed predecessor rather than reconstructing one", () => {
    const markup = renderDetail({
      message: { ...item().message, sequence_number: 2, parent_message_id: null },
      parent: null,
      initial: null,
      isInitial: false,
      typeLabel: "Follow-up #2",
    });

    expect(markup).toContain("Predecessor removed");
    // With no stored head, the gap is stated rather than filled.
    expect(markup).toContain("Not recorded");
  });

  it("renders the stored predecessor and head as context", () => {
    const initial = { ...item().message, id: "head", sequence_number: 0 };
    const parent = { ...item().message, id: "parent", sequence_number: 1, parent_message_id: "head" };

    const markup = renderDetail({
      message: { ...item().message, id: "current", sequence_number: 2, parent_message_id: "parent" },
      parent,
      initial,
      isInitial: false,
      typeLabel: "Follow-up #2",
    });

    expect(markup).toContain("Initial outreach");
    expect(markup).toContain("Follow-up #1");
    expect(markup).toContain("Follow-up #2");
    expect(markup).not.toContain("Predecessor removed");
  });
});