import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * "Smazat z historie" — the dashboard's side of the delete flow.
 *
 * THE CHANGE. The history table's Smazat button now removes sent leads too.
 * That required a new unguarded server action (`deleteLeadFromHistory`),
 * because the old `deleteUnsentLead` refuses any lead whose sequence-0
 * message carries a `sent_at` stamp. The UI must go through the new action —
 * and the row must leave the table the moment the server confirms, without a
 * round trip through the server page.
 *
 * WHY SOURCE PINS. The dashboard is a client component full of hooks and
 * effects; this repository renders components with `renderToStaticMarkup`, so
 * a click handler cannot be invoked here. Asserting on the handler's own
 * source is the honest way to keep the regression from coming back, and it
 * matches the existing precedent in `dashboard.history-open.test.ts`. The
 * server half of the contract — the cascade itself, for sent and unsent
 * leads — is covered by the real-service tests in
 * `draft-lead-management.e2e.test.ts`.
 */
const source = readFileSync(
  fileURLToPath(new URL("./dashboard.tsx", import.meta.url)),
  "utf8",
);

/** The body of `handleDeleteLead`, up to the next top-level declaration. */
function deleteHandler(): string {
  const start = source.indexOf("async function handleDeleteLead");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("async function handleOpenFromHistory", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe("Dashboard — Smazat z historie", () => {
  it("calls the unguarded server action, so sent leads can be deleted too", () => {
    // The regression: going back to `deleteUnsentLead` would silently make
    // the button a no-op for every sent lead — the server would answer
    // "already been sent" and the row would stay in the table.
    expect(deleteHandler()).toContain("deleteLeadFromHistory({ leadId: row.id })");
    // The guarded action is no longer reachable from this handler at all.
    expect(deleteHandler()).not.toContain("deleteUnsentLead");
  });

  it("removes the row from the table immediately after the server confirms", () => {
    const handler = deleteHandler();

    // Success is checked first…
    const successCheck = handler.indexOf("if (!result.ok)");
    expect(successCheck).toBeGreaterThan(-1);
    // …then the row is filtered out of the in-memory state — no reload of the
    // server page, so the UI refreshes in the same tick as the confirmation.
    const filtered = handler.indexOf(
      "setRows((current) => current.filter((lead) => lead.id !== row.id))",
    );
    expect(filtered).toBeGreaterThan(successCheck);
    // The failure branch returns before the filter, so a refused delete never
    // removes the row optimistically.
    const failureReturn = handler.indexOf("return;", successCheck);
    expect(failureReturn).toBeGreaterThan(-1);
    expect(failureReturn).toBeLessThan(filtered);
  });

  it("reloads the follow-up workspace, because pending follow-ups went too", () => {
    // The deleted lead's pending follow-ups are removed from the database by
    // the cascade; the workspace must not keep showing them.
    expect(deleteHandler()).toContain("void loadWorkspace();");
  });
});
