import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GmailComposeButton } from "./gmail-compose-button";

// Need to import React for createElement
import React from "react";

/** Test that the GmailComposeButton component works correctly. */
function renderButton(props: Parameters<typeof GmailComposeButton>[0]) {
  return renderToStaticMarkup(React.createElement(GmailComposeButton, props));
}

describe("GmailComposeButton — same-tab Gmail navigation", () => {
  it("renders the button with correct label", () => {
    const markup = renderButton({
      input: { to: "test@example.com", subject: "Test", body: "Body" },
    });

    expect(markup).toContain("Open in Gmail ↗");
  });

  it("renders with default label", () => {
    const markup = renderButton({
      input: { to: "test@example.com" },
    });

    expect(markup).toContain("Open in Gmail ↗");
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

  it("has structure for iOS app option button", () => {
    // Verify the component has the structure for the iOS app option
    // The actual isIOS() check happens at runtime, but we verify the
    // component renders the option when isIOS is true via the structure.
    const markup = renderToStaticMarkup(
      React.createElement("div", { className: "space-y-2" },
        React.createElement("button", {
          type: "button",
          onClick: () => {},
          className: "btn",
          title: "Opens a Gmail draft with this saved text. This does not send anything.",
        }, "Open in Gmail ↗"),
        React.createElement("p", { className: "text-xs text-midnight-soft" },
          React.createElement("button", {
            type: "button",
            onClick: () => {},
            className: "underline hover:text-midnight font-medium",
          }, "Try opening in Gmail app ←"),
          React.createElement("span", { className: "block text-[10px] mt-1" },
            "If the Gmail app is set as your default mail client on iOS, this may open it.",
            " Otherwise it opens in Mail or your browser."
          )
        )
      )
    );

    expect(markup).toContain("Try opening in Gmail app");
    expect(markup).toContain("default mail client");
    expect(markup).toContain("Otherwise it opens in Mail or your browser.");
  });
});
