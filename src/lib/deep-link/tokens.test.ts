import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ACTION_TOKEN_TTL_MS,
  expiresAt,
  generateActionToken,
  hashActionToken,
  isActionTokenFormat,
  isExpired,
  TOKEN_PATTERN,
  tokenDigestsMatch,
} from "./tokens";

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.PEPA_SESSION_SECRET;
});

describe("generateActionToken", () => {
  it("produces an opaque, prefixed, high-entropy token", () => {
    const token = generateActionToken();
    expect(token).toMatch(TOKEN_PATTERN);
    // "fp1_" prefix + 43 base64url characters from 32 random bytes
    expect(token).toHaveLength(4 + 43);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 2000 }, generateActionToken));
    expect(tokens.size).toBe(2000);
  });

  it("carries no lead id, email or readable content", () => {
    const token = generateActionToken();
    expect(token).not.toMatch(/@/);
    expect(token.slice(5)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("isActionTokenFormat", () => {
  it("rejects malformed values before any database work", () => {
    expect(isActionTokenFormat(generateActionToken())).toBe(true);
    expect(isActionTokenFormat("123")).toBe(false);
    expect(isActionTokenFormat("fp1_short")).toBe(false);
    expect(isActionTokenFormat("fp1_" + "a".repeat(42))).toBe(false);
    expect(isActionTokenFormat("fp1_" + "a".repeat(44))).toBe(false);
    expect(isActionTokenFormat("fp2_" + "a".repeat(43))).toBe(false);
    expect(isActionTokenFormat("")).toBe(false);
    expect(isActionTokenFormat(null)).toBe(false);
    expect(isActionTokenFormat(undefined)).toBe(false);
    expect(isActionTokenFormat("../../leads/1")).toBe(false);
  });
});

describe("hashActionToken", () => {
  it("is deterministic for the same token and secret", () => {
    const token = generateActionToken();
    expect(hashActionToken(token)).toBe(hashActionToken(token));
    expect(hashActionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never returns the raw token", () => {
    const token = generateActionToken();
    expect(hashActionToken(token)).not.toContain(token);
    expect(hashActionToken(token)).not.toContain(token.slice(5, 15));
  });

  it("produces different digests for different tokens", () => {
    const digests = new Set(Array.from({ length: 500 }, () => hashActionToken(generateActionToken())));
    expect(digests.size).toBe(500);
  });

  it("is domain-separated from the session cookie", async () => {
    const { createSessionToken } = await import("@/lib/auth/token");
    const sessionToken = createSessionToken();
    // The same bytes must not collide across the two signing purposes.
    expect(hashActionToken(sessionToken)).not.toBe(sessionToken);
  });

  it("changes with the signing key", () => {
    const token = generateActionToken();
    const before = hashActionToken(token);
    process.env.PEPA_SESSION_SECRET = "a-totally-different-secret-of-length-32+";
    expect(hashActionToken(token)).not.toBe(before);
  });

  it("fails closed without a usable secret", () => {
    const token = generateActionToken();

    delete process.env.PEPA_SESSION_SECRET;
    expect(() => hashActionToken(token)).toThrow(/PEPA_SESSION_SECRET/);

    process.env.PEPA_SESSION_SECRET = "too-short";
    expect(() => hashActionToken(token)).toThrow(/PEPA_SESSION_SECRET/);
  });
});

describe("tokenDigestsMatch", () => {
  it("compares digests exactly", () => {
    const digest = hashActionToken(generateActionToken());
    expect(tokenDigestsMatch(digest, digest)).toBe(true);
    expect(tokenDigestsMatch(digest, "0".repeat(64))).toBe(false);
  });
});

describe("expiry", () => {
  it("defaults to a bounded lifetime", () => {
    expect(DEFAULT_ACTION_TOKEN_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });

  it("computes an absolute expiry", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(expiresAt(now, 1000).toISOString()).toBe("2026-10-01T00:00:01.000Z");
  });

  it("treats past and boundary instants as expired", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const expiry = new Date(now).toISOString();

    expect(isExpired(expiry, now - 1)).toBe(false);
    expect(isExpired(expiry, now)).toBe(true); // expires at the boundary
    expect(isExpired(expiry, now + 1)).toBe(true);
  });

  it("treats an unparseable expiry as expired", () => {
    expect(isExpired("not-a-date")).toBe(true);
    expect(isExpired("")).toBe(true);
  });
});