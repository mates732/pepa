import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "./redirect";

describe("safeRedirectPath", () => {
  it("keeps same-origin absolute paths", () => {
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath("/login")).toBe("/login");
    expect(safeRedirectPath("/leads/42")).toBe("/leads/42");
  });

  it("rejects protocol-relative and absolute URLs (open redirects)", () => {
    expect(safeRedirectPath("//evil.example.com")).toBe("/");
    expect(safeRedirectPath("/\\evil.example.com")).toBe("/");
    expect(safeRedirectPath("https://evil.example.com")).toBe("/");
    expect(safeRedirectPath("http://evil.example.com")).toBe("/");
    expect(safeRedirectPath("/path\\to")).toBe("/");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
  });

  it("falls back for empty input", () => {
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath("")).toBe("/");
    expect(safeRedirectPath(null, "/login")).toBe("/login");
  });
});

describe("safeRedirectPath — Phase 8B notification destination", () => {
  const TOKEN = "fp1_testtokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("keeps the follow-up deep-link path intact across login", () => {
    // The destination a Telegram notification points at is a path, so it is the
    // one thing this function has to carry correctly.
    expect(safeRedirectPath(`/followup/${TOKEN}`)).toBe(`/followup/${TOKEN}`);
  });

  it("rejects a hostile destination aimed at the follow-up route", () => {
    // The route exists and is reachable, so these are exactly the shapes an
    // attacker would try to smuggle through it.
    expect(safeRedirectPath("//evil.example/followup")).toBe("/");
    expect(safeRedirectPath("/\\evil.example/followup")).toBe("/");
    expect(safeRedirectPath("https://evil.example/followup")).toBe("/");
    expect(safeRedirectPath("http://evil.example/followup")).toBe("/");
    expect(safeRedirectPath("javascript:alert(1)//followup")).toBe("/");
    expect(safeRedirectPath("data:text/html,<script>alert(1)</script>")).toBe("/");
  });

  it("never upgrades a relative path into an absolute one", () => {
    expect(safeRedirectPath("/followup/../..")).toBe("/followup/../..");
    expect(safeRedirectPath("/followup/%2e%2e/%2e%2e")).toBe("/followup/%2e%2e/%2e%2e");
    // Stricter than necessary, and worth pinning: a scheme anywhere in the value
    // is rejected outright, so a path cannot be used to smuggle one past a
    // naive "does it start with a slash?" check.
    expect(safeRedirectPath("/followup/https://evil.example")).toBe("/");
  });
});