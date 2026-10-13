import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    // These tests pin the composer/sequence controls, which every
    // row keeps; the unsent-only edit/delete controls are covered below.
    unsent: false,
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
        rows={[row({ id: "11111111-1111-1111-1111-111111111111" })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        openingMenuRowId="11111111-1111-1111-1111-111111111111"
      />,
    );

    expect(markup).toContain("Open");
    // The composer path is one control, not two.
    expect(markup.match(/>Open</g)).toHaveLength(1);
  });
});

describe("OutreachHistory — the Phase 8F sequence entry", () => {
  const ROW_ID = "11111111-1111-1111-1111-111111111111";

  it("offers a 'Sequence' control that opens the lead's sequence detail", () => {
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ROW_ID, unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        openingMenuRowId={ROW_ID}
      />,
    );

    expect(markup).toContain("Sequence");
  });

  it("says plainly that opening the sequence sends nothing", () => {
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ROW_ID, unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        openingMenuRowId={ROW_ID}
      />,
    );

    expect(markup).toContain("Nothing is sent.");
  });

  it("marks the row being opened and leaves the others actionable", () => {
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ROW_ID, unsent: true }), row({ id: "22222222-2222-2222-2222-222222222222", company_name: "Bistrot", unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={ROW_ID}
        openingMenuRowId={ROW_ID}
      />,
    );

    expect(markup).toContain("Opening…");
    // The in-flight row's Sequence button is disabled (because openingDetail is true).
    // The Open button is NOT disabled (only disabled when openingComposer is true).
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("renders a row for a lead whose newest message is still the sequence-0 draft", () => {
    // The exact case that was unreachable before: one stored message, no
    // follow-up yet, so the Follow-ups workspace shows only its empty state.
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ROW_ID, unsent: true, messageCount: 1, followup_count: 0, next_followup_at: null })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        openingMenuRowId={ROW_ID}
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

describe("OutreachHistory — loading a row into the composer", () => {
  // Loading a row is a server round trip now: the dashboard asks the server for
  // that lead's stored message rather than rebuilding the composer from the
  // row. The button therefore reports progress and refuses a second click,
  // because two clicks would be two identical reads and one confusing label.
  const ID_A = "aaaaaaaa-1111-4111-8111-111111111111";
  const ID_B = "bbbbbbbb-1111-4111-8111-111111111111";

  it("reports progress on the row being loaded and nothing else", () => {
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ID_A, unsent: true }), row({ id: ID_B, unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        openingComposerRowId={ID_A}
        openingMenuRowId={ID_A}
      />,
    );

    expect(markup).toContain("Opening…");
    // Exactly one row is in flight; its Open button shows "Opening…".
    expect(markup.match(/>Opening…</g)).toHaveLength(1);
    // Only the in-flight row's Open button is disabled (the Sequence button is disabled too).
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("leaves every row clickable when nothing is loading", () => {
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ID_A, unsent: true }), row({ id: ID_B, unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        openingMenuRowId={ID_A}
      />,
    );

    expect(markup.match(/>Open</g)).toHaveLength(1);
    expect(markup).not.toContain("Opening…");
    expect(markup).not.toContain("disabled: true");
  });

  it("does not confuse the composer load with the sequence detail load", () => {
    // Both controls can be in flight on different rows. The composer load must
    // never disable the "Sequence" button, which is a separate read.
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ID_A, unsent: true }), row({ id: ID_B, unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={ID_B}
        openingComposerRowId={ID_A}
        openingMenuRowId={ID_A}
      />,
    );

    // Row A's dropdown is open: its Open button shows "Opening…" (disabled).
    // Row B's dropdown is closed, so we only see Row A's menu.
    expect(markup).toContain("Opening…");
    // Row A's Open button is disabled, and Row A's Sequence button is disabled.
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("OutreachHistory — draft-lead management (Upravit/Smazat)", () => {
  const deleteHandler = vi.fn();

  it("offers explicit Upravit and Smazat controls on an unsent lead", () => {
    // The operator must be able to edit or delete an unsent lead
    // straight from the history table, without opening Gmail.
    const markup = render(
      <OutreachHistory
        rows={[row({ id: "11111111-1111-1111-1111-111111111111", unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        onDelete={deleteHandler}
        openingMenuRowId="11111111-1111-1111-1111-111111111111"
      />,
    );

    expect(markup).toContain("Upravit");
    expect(markup).toContain("Smazat");
  });

  it("keeps Upravit hidden on a sent lead but still offers Smazat", () => {
    // "Smazat z historie" is on EVERY row — sent history included — but
    // Upravit stays unsent-only: only a draft may be edited.
    const markup = render(
      <OutreachHistory
        rows={[row({ unsent: false })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        onDelete={deleteHandler}
        openingMenuRowId="11111111-1111-1111-1111-111111111111"
      />,
    );

    expect(markup).not.toContain("Upravit");
    expect(markup).toContain("Smazat");
    // The ordinary controls survive: Open is always present.
    expect(markup).toContain("Open");
  });

  it("offers no draft controls when deletion is not wired up", () => {
    // Optional prop: callers that do not delete must not render
    // a button that goes nowhere.
    const markup = render(
      <OutreachHistory
        rows={[row({ unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
      />,
    );

    expect(markup).not.toContain("Upravit");
    expect(markup).not.toContain("Smazat");
  });

  it("disables both draft controls while the deletion is in flight", () => {
    const ROW_ID = "aaaaaaaa-1111-4111-8111-111111111111";
    const markup = render(
      <OutreachHistory
        rows={[row({ id: ROW_ID, unsent: true })]}
        onLoadIntoComposer={noop}
        onOpenDetail={noop}
        openingDetailId={null}
        onDelete={deleteHandler}
        deletingRowId={ROW_ID}
        openingMenuRowId={ROW_ID}
      />,
    );

    expect(markup).toContain("Deleting…");
    // The row's every control is disabled: dropdown button, Upravit, Open, Sequence, Smazat.
    expect(markup.match(/disabled=""/g)).toHaveLength(5);
  });

  it("asks in Czech, and only in the dialog, before deleting", () => {
    // The confirmation dialog cannot be clicked in static markup, so
    // its exact wording is pinned on the source, the same way
    // dashboard.history-open.test.ts pins a handler's wording.
    const source = readFileSync(
      fileURLToPath(new URL("./outreach-history.tsx", import.meta.url)),
      "utf8",
    );
    const flattened = source.replace(/\s+/g, " ");

    // The dialog is opened by the Smazat button, not rendered inline.
    expect(source).toContain("setConfirmDeleteRow(row)");
    // Exact strings, verbatim (whitespace-normalised: the text wraps in JSX).
    expect(source).toContain("Smazat tento lead?");
    // The dialog covers sent leads too, so the old unsent-only wording
    // ("Tento lead ještě nebyl odeslán…") would misdescribe this deletion
    // and must be gone.
    expect(flattened).toContain(
      "Lead bude odstraněn z historie i databáze včetně jeho draftů a pending follow-upů. Tuto akci nelze vrátit.",
    );
    expect(source).not.toContain("Tento lead ještě nebyl odeslán");
    // The dialog's two actions, each the whole text of its button
    // (whitespace-tolerant: the labels are the only content).
    expect(source).toMatch(/>\s*Zrušit\s*</);
    expect(source).toMatch(/>\s*Smazat\s*</);
    // The confirm button calls the delete handler with the row that
    // was confirmed, and dismissing does not.
    expect(source).toContain("onDelete(target)");
  });

  it("cancelling the confirmation calls no delete handler at all", () => {
    // The dialog cannot be clicked in static markup, so the cancel path is
    // pinned on the source: the Zrušit button's own tag must close the dialog
    // and nothing else, while `onDelete(target)` exists exactly once — inside
    // the confirm button. If cancellation ever reached the handler, the e2e
    // cascade tests would be deleting leads from a dismissed dialog.
    const source = readFileSync(
      fileURLToPath(new URL("./outreach-history.tsx", import.meta.url)),
      "utf8",
    );

    // The LAST occurrence: the first one lives in a comment near the top
    // ("Escape dismisses the confirmation, exactly like Zrušit"), which sits
    // before any button in the file.
    const labelIndex = source.lastIndexOf("Zrušit");
    expect(labelIndex).toBeGreaterThan(-1);
    const cancelStart = source.lastIndexOf("<button", labelIndex);
    const cancelEnd = source.indexOf("</button>", labelIndex);
    expect(cancelStart).toBeGreaterThan(-1);
    expect(cancelEnd).toBeGreaterThan(cancelStart);

    const cancelButton = source.slice(cancelStart, cancelEnd);
    expect(cancelButton).toContain("setConfirmDeleteRow(null)");
    expect(cancelButton).not.toContain("onDelete");

    // The destructive call exists exactly once in the whole component.
    expect(source.match(/onDelete\(/g) ?? []).toHaveLength(1);
  });
});
