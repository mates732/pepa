import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OutreachHistory } from "@/components/outreach-history";
import type { OutreachHistoryRow } from "@/lib/types";

/**
 * Outreach history row controls.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component tests.
 *
 * Phase 8F added a second control beside the existing one. The pinned
 * properties are that BOTH exist and are independently labelled: the original
 * "Open" loads the row into the composer and must keep working unchanged, while
 * the new "Sequence" opens the lead's sequence detail. Two identically named
 * buttons would be indistinguishable to the operator, so their labels are part
 * of the contract.
 */

function row(overrides: Partial<OutreachHistoryRow> = {}): OutreachHistoryRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: "info@thearchive.cz",
    company_name: "The Archive",
    contact_name: null,
    status: "ready",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
    latestSubject: "AI recepce pro The Archive",
    latestMessageStatus: "draft",
    latestMessageAt: "2026-09-20T00:00:00.000Z",
    messageCount: 1,
    lastFollowupNotifiedNumber: null,
    lastFollowupNotifiedAt: null,
    ...overrides,
  };
}

function render(element: React.ReactElement) {
  return renderToStaticMarkup(element);
}

const noop = vi.fn();

describe("OutreachHistory — the composer entry is unchanged", () => {
  it("still offers a single 'Open' control for the composer", () => {
    const markup = render(
      <OutreachHistory
        rows={[row()]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
      />,
    );

    expect(markup).toContain("Open");
    // The composer path is one control, not two.
    expect(markup.match(/>Open</g)).toHaveLength(1);
  });
});

describe("OutreachHistory — the Phase 8F sequence entry", () => {
  it("offers a 'Sequence' control that opens the lead's sequence detail", () => {
    const markup = render(
      <OutreachHistory
        rows={[row()]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
      />,
    );

    expect(markup).toContain("Sequence");
  });

  it("says plainly that opening the sequence sends nothing", () => {
    const markup = render(
      <OutreachHistory
        rows={[row()]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
      />,
    );

    expect(markup).toContain("Nothing is sent.");
  });

  it("marks the row being opened and leaves the others actionable", () => {
    const markup = render(
      <OutreachHistory
        rows={[row(), row({ id: "22222222-2222-2222-2222-222222222222", company_name: "Bistrot" })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId="11111111-1111-1111-1111-111111111111"
      />,
    );

    expect(markup).toContain("Opening…");
    // The other row is still clickable — only one row is in flight.
    expect(markup.match(/>Sequence</g)).toHaveLength(1);
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("renders a row for a lead whose newest message is still the sequence-0 draft", () => {
    // The exact case that was unreachable before: one stored message, no
    // follow-up yet, so the Follow-ups workspace shows only its empty state.
    const markup = render(
      <OutreachHistory
        rows={[row({ messageCount: 1, followup_count: 0, next_followup_at: null })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
      />,
    );

    expect(markup).toContain("Sequence");
    expect(markup).toContain("The Archive");
  });

  it("keeps the honest empty state when there are no leads at all", () => {
    const markup = render(
      <OutreachHistory rows={[]} onLoadIntoComposer={noop} onOpenDetail={noop} openingDetailId={null} />,
    );

    expect(markup).toContain("No leads yet.");
    expect(markup).not.toContain("Sequence");
  });
});
