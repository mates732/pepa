import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  constantTimeEquals,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from "./token";

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.PEPA_SESSION_SECRET;
});

describe("session token", () => {
  it("round-trips a freshly issued token", () => {
    const token = createSessionToken();
    const payload = verifySessionToken(token);

    expect(payload).not.toBeNull();
    expect(payload?.v).toBe(1);
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(SESSION_TTL_SECONDS);
  });

  it("rejects a missing token", () => {
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken("")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken();
    const [version, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, iat: 0, exp: 9_999_999_999 }),
      "utf8",
    ).toString("base64url");

    expect(verifySessionToken(`${version}.${forged}.${signature}`)).toBeNull();
  });

  it("rejects a forged signature", () => {
    const token = createSessionToken();
    const parts = token.split(".");
    expect(verifySessionToken(`${parts[0]}.${parts[1]}.${"a".repeat(43)}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = createSessionToken();
    process.env.PEPA_SESSION_SECRET = "a-completely-different-secret-value-32+";
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    const issuedAt = Date.now();
    const token = createSessionToken(issuedAt);
    const longAfter = issuedAt + (SESSION_TTL_SECONDS + 60) * 1000;

    expect(verifySessionToken(token, issuedAt)).not.toBeNull();
    expect(verifySessionToken(token, longAfter)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySessionToken("nonsense")).toBeNull();
    expect(verifySessionToken("v1.only-two-parts")).toBeNull();
    expect(verifySessionToken(`v2.a.b`)).toBeNull();
  });

  it("fails closed when the secret is missing or too short", () => {
    const token = createSessionToken();

    delete process.env.PEPA_SESSION_SECRET;
    expect(verifySessionToken(token)).toBeNull();
    expect(() => createSessionToken()).toThrow(/PEPA_SESSION_SECRET/);

    process.env.PEPA_SESSION_SECRET = "too-short";
    expect(verifySessionToken(token)).toBeNull();
  });

  it("uses a fixed, non-enumerable cookie name", () => {
    expect(SESSION_COOKIE).toBe("pepa_session");
  });
});

describe("constantTimeEquals", () => {
  it("compares correctly", () => {
    expect(constantTimeEquals("pepa", "pepa")).toBe(true);
    expect(constantTimeEquals("pepa", "pepb")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("a", "")).toBe(false);
  });
});