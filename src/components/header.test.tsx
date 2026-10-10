import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import React from "react";

import { Header } from "./header";

/**
 * Test the header component's mobile menu button functionality.
 * 
 * The header renders a mobile menu button (☰) that toggles a navigation
 * sidebar. The button must be clickable and update its aria-expanded state.
 */
function renderHeader(props?: { onNavToggle?: () => void }) {
  // Create a wrapper that captures the toggle callback
  const onNavToggle = props?.onNavToggle ?? vi.fn();
  
  return renderToStaticMarkup(
    React.createElement(Header, {},
      // The Header component doesn't accept props, so we can't pass callbacks
      // directly. We'll test the rendered output instead.
    )
  );
}

describe("Header — mobile menu button", () => {
  it("renders the mobile menu button with correct aria attributes", () => {
    const markup = renderToStaticMarkup(<Header />);

    // The button should have the correct aria-label and initial aria-expanded state
    expect(markup).toContain('aria-label="Toggle navigation"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("☰");
  });

  it("renders navigation links in the sidebar", () => {
    const markup = renderToStaticMarkup(<Header />);

    // Navigation links should be present in the sidebar
    expect(markup).toContain("Dashboard");
    expect(markup).toContain("Paste Emails");
    expect(markup).toContain("Drafts");
    expect(markup).toContain("Outreach");
    expect(markup).toContain("Follow-ups");
  });

  it("has the menu button in the mobile header (lg:hidden)", () => {
    const markup = renderToStaticMarkup(<Header />);

    // The mobile header should contain the menu button
    // The button is inside a header with lg:hidden class
    expect(markup).toMatch(/<header[^>]*lg:hidden[^>]*>/);
    expect(markup).toContain('<button');
    expect(markup).toContain('aria-label="Toggle navigation"');
  });

  it("renders the sidebar with correct structure", () => {
    const markup = renderToStaticMarkup(<Header />);

    // The sidebar should have the PEPA branding
    expect(markup).toContain("PEPA");
    expect(markup).toContain("Sign out");
    expect(markup).toContain('/api/auth/signout');
  });
});
