import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GmailComposeButton } from "./gmail-compose-button";

/** Test that the GmailComposeButton component works correctly. */
function renderButton(props: Parameters<typeof GmailComposeButton>[0]) {
  return renderToStaticMarkup(React.createElement(GmailComposeButton, props));
}

// Need to import React for createElement
import React from "react";

describe("GmailComposeButton — same-tab Gmail navigation", () => {
  it("renders the button with correct label", () => {
    const markup = renderButton({
      input: { to: "test@example.com", subject: "Test", body: "Body" },
    });

    expect(markup).toContain("Open in Gmail ↗");
  });

  it("renders with custom label", () => {
    const markup = renderButton({
      input: { to: "test@example.com" },
      label: "Open Gmail",
    });

    expect(markup).toContain("Open Gmail");
  });

  it("is not disabled by default", () => {
    const markup = renderButton({
      input: { to: "test@example.com" },
    });

    expect(markup).not.toContain('disabled');
  });

  it("supports disabled state", () => {
    const markup = renderButton({
      input: { to: "test@example.com" },
      disabled: true,
    });

    expect(markup).toContain('disabled');
  });

  it("renders with custom title", () => {
    const markup = renderButton({
      input: { to: "test@example.com" },
      title: "Custom tooltip",
    });

    expect(markup).toContain('title="Custom tooltip"');
  });

  it("does not render notice area (navigation is instant)", () => {
    const markup = renderButton({
      input: { to: "test@example.com" },
    });

    // The component no longer renders a notice area since navigation is synchronous
    expect(markup).not.toContain("space-y-2");
  });
});
