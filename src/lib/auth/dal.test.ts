import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken, SESSION_COOKIE } from "./token";
import { AuthenticationError, currentUser, requireAuthenticatedUser, verifySession } from "./dal";

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

const cookieStore = new Map<string, string>();
const redirectMock = vi.fn((path: string) => {
  const error = new Error(`NEXT_REDIRECT:${path}`) as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${path};307;`;
  throw error;
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) } : undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
  cookieStore.clear();
  redirectMock.mockClear();
});

describe("requireAuthenticatedUser", () => {
  it("rejects a request with no cookie", async () => {
    await expect(requireAuthenticatedUser()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a forged cookie", async () => {
    cookieStore.set(SESSION_COOKIE, "v1.abc.def");
    await expect(requireAuthenticatedUser()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an expired cookie", async () => {
    const token = createSessionToken(Date.now() - 60 * 60 * 24 * 40 * 1000);
    cookieStore.set(SESSION_COOKIE, token);
    await expect(requireAuthenticatedUser()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("accepts a valid signed cookie", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    await expect(requireAuthenticatedUser()).resolves.toMatchObject({ id: "owner" });
  });
});

describe("currentUser", () => {
  it("returns null instead of throwing when signed out", async () => {
    await expect(currentUser()).resolves.toBeNull();
  });

  it("returns the owner for a valid session", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    await expect(currentUser()).resolves.toMatchObject({ id: "owner" });
  });
});

describe("verifySession (page guard)", () => {
  it("redirects to /login when unauthenticated", async () => {
    await expect(verifySession()).rejects.toThrow(/NEXT_REDIRECT:\/login/);
  });

  it("returns the user without redirecting when authenticated", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    await expect(verifySession()).resolves.toMatchObject({ id: "owner" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});