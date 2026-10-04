import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ImportEditor } from "./import-editor";

/**
 * The ChatGPT-imported draft's last hop.
 *
 * The import deep link could always show and edit the prepared draft; it could
 * not reach Gmail. These assertions pin the control that closes that gap, and
 * pin the two statements that keep it honest:
 *
 *   * "Open in Gmail" is present, enabled and disabled only while the action is
 *     in flight — the button is never a dead control here, because an imported
 *     draft always has a stored message behind it;
 *   * it says that it fills from the SAVED text and that Send is still pressed by
 *     the operator in Gmail. Neither is decoration: both are the difference
 *     between a fast workflow and a workflow that sends the wrong email.
 */

vi.mock("@/app/import-actions", () => ({
  saveImport: vi.fn(),
  openImportInGmail: vi.fn(),
}));

function render() {
  return renderToStaticMarkup(
    <ImportEditor
      token="fp1_opaque-token"
      recipient="katy@beautysalon.cz"
      subject="AI recepce pro Beautysalon v Průhonicích"
      body="Dobrý den, paní Klimentová,\n\nDíky, Pavel"
    />,
  );
}

function buttonsOf(markup: string): string[] {
  return markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

describe("ImportEditor — Open in Gmail", () => {
  it("offers the Gmail control, enabled", () => {
    const gmailButton = buttonsOf(render()).find((b) => b.includes("Open in Gmail"));

    expect(gmailButton).toBeDefined();
    expect(gmailButton).not.toContain("disabled");
  });

  it("says the window is opened with the saved draft, not the edited text", () => {
    // The one genuinely surprising case: edit, forget to save, get the old text.
    const markup = render();

    expect(markup).toContain("fills from the saved draft");
    expect(markup).toContain("save your edits first");
  });

  it("keeps the manual Send explicit", () => {
    const markup = render();

    expect(markup).toContain("You still press");
    expect(markup).toContain("Send in Gmail yourself");
    // Opening Gmail must never read as having sent anything.
    expect(markup).toContain("does not send anything and does not mark it as sent");
  });

  it("does not put the token anywhere a rendered page would leak it into a link", () => {
    // The token lives in the client bundle for this page by necessity — it is
    // the capability being redeemed — but it must not be echoed into visible
    // text, where it would end up in a screenshot or a shared screen.
    const markup = render();

    expect(markup).not.toContain("fp1_opaque-token");
  });

  it("still offers the import save path", () => {
    const markup = render();

    expect(markup).toContain("katy@beautysalon.cz");
    expect(markup).toContain("AI recepce pro Beautysalon v Průhonicích");
    // No send control that works: sending arrives with the EmailProvider phase.
    expect(markup).toMatch(/>\s*Send\s*</);
  });
});
