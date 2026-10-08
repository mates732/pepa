import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Outreach history → composer: the "Open in Gmail" regression guard.
 *
 * THE BUG. Opening a lead from Outreach history rebuilt the composer in the
 * browser from the history row:
 *
 *     setValues({ recipient: row.email, subject: row.latestSubject ?? "",
 *                 body: "", messageId: null, leadId: row.id });
 *
 * The row exposes a LEAD id, never a message id, so `messageId` was forced to
 * null. `EmailComposer` disables "Open in Gmail" on `!values.messageId`, so the
 * button was dead there and the click fired no handler at all — a real-browser
 * diagnostic measured zero `window.open` calls, zero network requests and zero
 * new tabs. The body was dropped too, so saving would have blanked the stored
 * draft.
 *
 * THE FIX. Resolve the lead's stored message server-side through the existing
 * `loadInitialOutreachDetail` action and fill the composer from it via
 * `composerValuesFromSavedMessage`.
 *
 * WHY THIS FILE EXISTS. The dashboard is a client component full of hooks and
 * effects; this repository renders components with `renderToStaticMarkup`, so a
 * click handler cannot be invoked here. Asserting on the handler's own source is
 * the honest way to keep the regression from coming back, and it matches the
 * existing precedent in `actions.gmail.test.ts`, which pins behaviour by reading
 * the module source. The mapping itself is covered directly and without
 * indirection by `composer-values.test.ts`.
 */
const source = readFileSync(
  fileURLToPath(new URL("./dashboard.tsx", import.meta.url)),
  "utf8",
);

/** The body of `handleOpenFromHistory`, up to the next top-level declaration. */
function historyHandler(): string {
  const start = source.indexOf("async function handleOpenFromHistory");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("\n  // Global shortcuts", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe("Dashboard — opening a history row into the composer", () => {
  it("resolves the stored message server-side instead of rebuilding from the row", () => {
    // The browser names a LEAD; the database decides which row that lead's
    // initial outreach is. This is what supplies the message id.
    expect(historyHandler()).toContain(
      "loadLeadOutreachPair({ leadId: row.id })",
    );
    expect(historyHandler()).toContain("composerValuesFromSavedMessage");
  });

  it("never forces a null message id on the saved path", () => {
    // The exact regression. `messageId: null` may appear only inside the
    // fallback branch, which is reached solely when the server reports that the
    // lead has no stored draft at all.
    const handler = historyHandler();

    expect(handler).toContain("messageId: null");
    // ...and that branch is guarded by the server's answer, not by the row.
    expect(handler).toContain("if (!result.ok)");
    // The saved path sets the id from the stored row.
    expect(handler).toContain("mainMessage: result.main");
  });

  it("does not drop the saved body when a row is opened", () => {
    // The old handler hard-coded `mainBody: ""`, which would have blanked a stored
    // draft the moment the operator pressed Save. That may only survive inside
    // the no-stored-draft fallback.
    const handler = historyHandler();
    const savedPath = handler.split("mainMessage: result.main")[1] ?? "";

    expect(handler).toContain('mainBody: ""');
    expect(savedPath).not.toContain('mainBody: ""');
  });

  it("marks the loaded content as saved, because it is the stored draft", () => {
    // Without this the composer would claim the content is unsaved and grey out
    // controls that are perfectly valid for a stored draft.
    expect(historyHandler()).toContain("setSaved(true)");
  });

  it("explains itself on the fallback path instead of leaving a dead button", () => {
    const handler = historyHandler();

    expect(handler).toContain("Save this one before opening it in Gmail.");
    expect(handler).toContain("setOpeningComposerRowId");
  });

  it("is a read: the handler contains no send-recording call", () => {
    // Loading a row must never be able to record a send.
    expect(historyHandler()).not.toContain("recordOutreachSent");
  });

  it("leaves the three existing Gmail handlers untouched", () => {
    // They already work, verified end to end in a real browser. The fix belongs
    // to the composer entry, not to the popup-safe mechanism these share.
    for (const handler of [
      "handleOpenInGmail",
      "handleOpenDetailInGmail",
      "handleOpenActivityInGmail",
    ]) {
      expect(source).toContain(handler);
    }

    // …and none of those three handlers records a send.
    for (const handler of [
      "handleOpenInGmail",
      "handleOpenDetailInGmail",
      "handleOpenActivityInGmail",
    ]) {
      const body = source.slice(
        source.indexOf(`async function ${handler}`),
        source.indexOf("\n  }", source.indexOf(`async function ${handler}`)) +
          3,
      );
      expect(body).not.toContain("recordOutreachSent");
    }

    // Each handler preopens a tab and navigates it with a URL from the server.
    expect(source.match(/preopenComposeWindow\(\)/g)).toHaveLength(6);
    expect(
      source.match(/navigateComposeWindow\(tab, result\.mailtoUrl\)/g),
    ).toHaveLength(3);
    expect(
      source.match(/navigateComposeWindow\(webTab, result\.webUrl\)/g),
    ).toHaveLength(3);
  });
});
