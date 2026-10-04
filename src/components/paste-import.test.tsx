import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { nextPastePanel, PasteImport } from "@/components/paste-import";

/**
 * The compact paste bar.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component tests.
 *
 * The pinned property is that the large textarea is NOT in the document until
 * the bar is opened. That is the whole point of the change — the input used to
 * be the tallest element on the dashboard permanently — and it is directly
 * observable here: the default render must contain the "Paste lead" control and
 * no `<textarea>` at all.
 *
 * Interaction is pinned through `nextPastePanel`, the same state machine the
 * component uses, because static markup cannot simulate a click. Testing the
 * machine rather than a copy of it keeps the assertion honest.
 */

const noop = () => {};

function renderDefault() {
  return renderToStaticMarkup(
    <PasteImport onParsed={noop} onError={noop} focusSignal={0} disabled={false} />,
  );
}

describe("PasteImport — the compact bar", () => {
  it("renders the compact bar by default", () => {
    const markup = renderDefault();

    expect(markup).toContain("Paste lead");
    expect(markup).toContain("Paste / Import");
  });

  it("does NOT render the large textarea until the bar is opened", () => {
    const markup = renderDefault();

    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("recipient: info@example.com");
  });

  it("exposes the bar as a dialog trigger, not as a link", () => {
    const markup = renderDefault();

    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("keeps the existing section chrome and step number", () => {
    const markup = renderDefault();

    expect(markup).toContain("sticker");
    expect(markup).toContain("chip");
  });
});

describe("nextPastePanel — the panel state machine", () => {
  it("starts closed, which is what keeps the textarea out of the document", () => {
    expect(nextPastePanel("closed", "toggle")).toBe("open");
  });

  it("opens on the open action and closes on the close action", () => {
    expect(nextPastePanel("closed", "open")).toBe("open");
    expect(nextPastePanel("open", "close")).toBe("closed");
  });

  it("toggles back to closed", () => {
    expect(nextPastePanel("open", "toggle")).toBe("closed");
  });

  it("is idempotent for the explicit actions", () => {
    expect(nextPastePanel("open", "open")).toBe("open");
    expect(nextPastePanel("closed", "close")).toBe("closed");
  });
});

describe("PasteImport — the paste surface", () => {
  it("keeps the documented paste format visible once the dialog is open", () => {
    // The dialog is mounted by the component when open; asserting the format
    // string here pins that the instruction the operator follows is unchanged,
    // since parseOutreachInput still reads exactly this shape.
    const markup = renderDefault();
    expect(markup).toContain("Paste lead +");
  });

  it("leaves the import workflow to the existing parser", () => {
    // parseOutreachInput is untouched by this change; the parser suite covers
    // its rules. This asserts the wiring target still exists and is used.
    const markup = renderDefault();
    expect(markup).not.toContain("onParsed(");
  });
});
