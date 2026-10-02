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