import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FollowUpDetail } from "@/components/follow-up-detail";
import type { FollowUpDetail as FollowUpDetailData } from "@/lib/services/follow-up-sequence-service";

/**
 * The Phase 8F "Next follow-up" form inside the detail.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component tests.
 *
 * The pinned property is reachability. This form is the only entry to the
 * follow-up draft action, and the detail for a sequence-0 message is the one
 * place a brand-new lead can reach it — the Follow-ups workspace lists only
 * `sequence_number > 0`. So the form must render for an initial outreach and
 * must propose the next slot, not the current one.
 *
 * Creation is delegated: the component calls `onCreateFollowUp`, which the
 * dashboard wires to the session-gated `createFollowUp()` action. The component
 * itself never creates a row and never notifies anyone, so the assertions below
 * pin the callback boundary rather than any behaviour of the action itself
 * (which `followup-actions.test.ts` covers).
 */

function detail(overrides: Partial<FollowUpDetailData> = {}): FollowUpDetailData {
  const message = {
    id: "99999999-9999-4999-8999-999999999999",
    lead_id: "11111111-1111-1111-1111-111111111111",
    recipient_email: "info@thearchive.cz",
    subject: "AI recepce pro The Archive",
    body: "Původní text.",
    status: "draft" as const,
    provider: null,
    provider_message_id: null,
    sent_at: null,
    created_at: "2026-10-04T10:00:00.000Z",
    sequence_number: 0,
    parent_message_id: null,
  };

  return {
    lead: {
      id: "11111111-1111-1111-1111-111111111111",
      email: "info@thearchive.cz",
      company_name: "The Archive",
      contact_name: null,
      status: "ready" as const,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-10-04T10:00:00.000Z",
      last_contacted_at: null,
      next_followup_at: null,
      followup_count: 0,
    },
    message,
    initial: message,
    parent: null,
    isInitial: true,
    unrecordedHistory: false,
    ...overrides,
  } as FollowUpDetailData;
}

const noop = vi.fn();

function render(element: React.ReactElement) {
  return renderToStaticMarkup(element);
}

describe("FollowUpDetail — reachable from a sequence-0 initial outreach", () => {
  it("renders the 'Next follow-up' form for an initial outreach", () => {
    const markup = render(
      <FollowUpDetail
        detail={detail()}
        onClose={noop}
        onOpenInGmail={noop}
        onMarkSent={noop}
        onCreateFollowUp={noop}
        openingGmail={false}
        recording={false}
        creating={false}
        notice={null}
      />,
    );

    expect(markup).toContain("Next follow-up");
    expect(markup).toContain("Follow-up subject");
  });

  it("proposes the NEXT slot, so sequence 0 offers follow-up #1", () => {
    const markup = render(
      <FollowUpDetail
        detail={detail()}
        onClose={noop}
        onOpenInGmail={noop}
        onMarkSent={noop}
        onCreateFollowUp={noop}
        openingGmail={false}
        recording={false}
        creating={false}
        notice={null}
      />,
    );

    expect(markup).toContain("Save follow-up #1");
    expect(markup).not.toContain("Save follow-up #0");
  });

  it("offers follow-up #2 from a sequence-1 message", () => {
    const base = detail();
    const followUp = { ...base.message, id: "aaaa1111-1111-4111-8111-111111111111", sequence_number: 1 };

    const markup = render(
      <FollowUpDetail
        detail={{ ...base, message: followUp, isInitial: false, initial: base.message, parent: null }}
        onClose={noop}
        onOpenInGmail={noop}
        onMarkSent={noop}
        onCreateFollowUp={noop}
        openingGmail={false}
        recording={false}
        creating={false}
        notice={null}
      />,
    );

    expect(markup).toContain("Save follow-up #2");
  });

  it("states that saving notifies nobody", () => {
    const markup = render(
      <FollowUpDetail
        detail={detail()}
        onClose={noop}
        onOpenInGmail={noop}
        onMarkSent={noop}
        onCreateFollowUp={noop}
        openingGmail={false}
        recording={false}
        creating={false}
        notice={null}
      />,
    );

    expect(markup).toContain("Saving a follow-up sends nothing and notifies nobody.");
  });
});

describe("FollowUpDetail — creation is delegated to the action", () => {
  it("disables the submit control while a save is in flight", () => {
    const markup = render(
      <FollowUpDetail
        detail={detail()}
        onClose={noop}
        onOpenInGmail={noop}
        onMarkSent={noop}
        onCreateFollowUp={noop}
        openingGmail={false}
        recording={false}
        creating
        notice={null}
      />,
    );

    expect(markup).toContain("Saving…");
    expect(markup).toContain('disabled=""');
  });

  it("keeps the existing Gmail and mark-as-sent controls intact", () => {
    const markup = render(
      <FollowUpDetail
        detail={detail()}
        onClose={noop}
        onOpenInGmail={noop}
        onMarkSent={noop}
        onCreateFollowUp={noop}
        openingGmail={false}
        recording={false}
        creating={false}
        notice={null}
      />,
    );

    expect(markup).toContain("Open in Gmail");
    expect(markup).toContain("Mark as sent");
    expect(markup).toContain("Opening Gmail does not mark this as sent.");
  });
});
