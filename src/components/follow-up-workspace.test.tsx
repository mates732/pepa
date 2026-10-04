import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FollowUpWorkspace } from "@/components/follow-up-workspace";
import type { FollowUpListItem } from "@/lib/services/follow-up-sequence-service";

/**
 * Follow-ups workspace header tests.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component tests.
 *
 * Phase 8C added the actionable count, so the pinned property is that the header
 * answers "what do I do this morning?" — it must count only follow-ups the server
 * marked `attention === 0` (unsent and past due), must never inflate that count
 * with already-sent rows, and must degrade honestly while loading or on error.
 */

/** A stored follow-up row, shaped as `listFollowUps` returns it. */
function item(overrides: Partial<FollowUpListItem> = {}): FollowUpListItem {
  return {
    message: {
      id: "55555555-5555-5555-5555-555555555555",
      lead_id: "11111111-1111-1111-1111-111111111111",
      recipient_email: "info@thearchive.cz",
      subject: "Re: AI recepce",
      body: "Navazuji",
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-09-29T00:00:00.000Z",
      sequence_number: 1,
      parent_message_id: null,
    },
    lead: {
      id: "11111111-1111-1111-1111-111111111111",
      email: "info@thearchive.cz",
      company_name: "The Archive",
      contact_name: null,
    },
    due: true,
    dueAt: "2026-10-01T08:00:00.000Z",
    attention: 0,
    ...overrides,
  };
}

function sentItem(overrides: Partial<FollowUpListItem> = {}): FollowUpListItem {
  return item({
    ...overrides,
    message: {
      ...item(overrides).message,
      id: "66666666-6666-6666-6666-666666666666",
      status: "sent",
      sent_at: "2026-09-30T09:00:00.000Z",
    },
    attention: 2,
  });
}

function render(props: Partial<React.ComponentProps<typeof FollowUpWorkspace>> = {}): string {
  return renderToStaticMarkup(
    <FollowUpWorkspace
      followUps={[]}
      onSelect={() => undefined}
      loading={false}
      error={null}
      selectedId={null}
      {...props}
    />,
  );
}

describe("FollowUpWorkspace header — Phase 8C actionable count", () => {
  it("counts only follow-ups that need attention now", () => {
    const markup = render({
      followUps: [item(), item({ message: { ...item().message, id: "77777777-7777-7777-7777-777777777777" } }), sentItem()],
    });

    // Two unsent-and-due rows; the sent one is recorded but not actionable.
    expect(markup).toContain("2 need attention");
    expect(markup).toContain("3 recorded");
  });

  it("shows the total without alarming language when nothing is due", () => {
    const markup = render({ followUps: [sentItem(), item({ attention: 1, due: false, dueAt: null })] });

    expect(markup).not.toContain("need attention");
    expect(markup).toContain("2 recorded");
  });

  it("is not a control: the header renders no actionable element", () => {
    const markup = render({ followUps: [item()] });

    // The count is information. Acting on a follow-up stays an explicit click on
    // that follow-up in the list below, so the header must not be clickable.
    const header = markup.slice(0, markup.indexOf("</header>"));
    expect(header).not.toContain("<button");
    expect(header).not.toContain("Mark as sent");
  });

  it("does not claim a count while loading", () => {
    const markup = render({ followUps: [item()], loading: true });

    expect(markup).toContain("Loading…");
    expect(markup).not.toContain("need attention");
  });

  it("shows the honest empty state instead of a zero count", () => {
    const markup = render({ followUps: [] });

    expect(markup).toContain("No follow-ups recorded");
    expect(markup).not.toContain("need attention");
  });

  it("agrees with the group heading it counts", () => {
    const markup = render({ followUps: [item(), sentItem()] });

    // The count and the grouping come from the same `attention` value, so they
    // cannot drift: exactly one row is under "Needs attention".
    expect(markup).toContain("1 need attention");
    expect(markup).toContain("Needs attention");
  });
});
