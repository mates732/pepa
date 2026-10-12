import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { usePathname } from "next/navigation";

import { Header } from "./header";

/**
 * App-shell contract: sidebar/drawer navigation, the compact top bar, the
 * login gate staying chrome-free, and the structural pairing with the root
 * layout (sidebar sits BESIDE the content on desktop ≥1200px, never stacked
 * above it — stacking was the cause of the giant empty area above the
 * dashboard).
 */

vi.mock("next/navigation", () => ({ usePathname: vi.fn(() => "/") }));
vi.mock("@/app/auth-actions", () => ({ logout: async () => undefined }));

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
    expect(markup).toContain("<button");
    expect(markup).toContain('aria-label="Toggle navigation"');
  });

  it("renders the sidebar with correct structure", () => {
    const markup = renderToStaticMarkup(<Header />);

    // The sidebar should have the PEPA branding
    expect(markup).toContain("PEPA");
    expect(markup).toContain("Sign out");
    // The drawer target referenced by aria-controls must exist.
    expect(markup).toContain('id="mobile-nav"');
  });
});

describe("Header — sign-out uses the real logout server action", () => {
  it("does not POST to the nonexistent /api/auth/signout route (404)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./header.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain("/api/auth/signout");
    expect(source).toContain('import { logout } from "@/app/auth-actions"');
    expect(source).toContain("<form action={logout}>");
  });
});

describe("Header — login gate renders no app chrome", () => {
  it("returns null on /login (no sidebar, no top bar, no sign-out)", () => {
    vi.mocked(usePathname).mockReturnValue("/login");

    const markup = renderToStaticMarkup(<Header />);

    expect(markup).toBe("");
  });

  it("renders the shell on every other route", () => {
    vi.mocked(usePathname).mockReturnValue("/drafts");

    const markup = renderToStaticMarkup(<Header />);

    expect(markup).toContain("PEPA");
    vi.mocked(usePathname).mockReturnValue("/");
  });
});

describe("Root layout — desktop sidebar beside the content", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../app/layout.tsx", import.meta.url)),
    "utf8",
  );

  it("makes the body a ROW at lg so the sidebar is not stacked above main", () => {
    expect(source).toContain("lg:flex-row");
    expect(source).toContain("min-h-dvh");
  });

  it("keeps main growing in the row with min-w-0 (no horizontal overflow)", () => {
    expect(source).toMatch(/<main className="min-w-0 flex-1/);
  });

  it("pairs the layout with a sticky viewport-height sidebar in the header", () => {
    const header = readFileSync(
      fileURLToPath(new URL("./header.tsx", import.meta.url)),
      "utf8",
    );

    expect(header).toContain("lg:sticky");
    expect(header).toContain("lg:h-dvh");
    expect(header).toContain("lg:w-56");
  });
});
