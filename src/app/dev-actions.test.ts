import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { devToolsEnabled } from "@/app/dev-actions";

/**
 * The dev-tools gate. This action sends real Telegram messages and mints real
 * action_tokens rows, so the production behaviour is the security-relevant part
 * and is asserted unconditionally.
 */

vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Keeps the test off the real session/cookie path; devToolsEnabled() itself
// never consults the session, but the module graph does.
vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ id: "owner", since: 0 })),
}));

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("devToolsEnabled — production is hard-disabled", () => {
  it("returns false even when PEPA_ENABLE_DEV_TOOLS is explicitly true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", "true");

    await expect(devToolsEnabled()).resolves.toBe(false);
  });

  it("returns false when PEPA_ENABLE_DEV_TOOLS is false", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", "false");

    await expect(devToolsEnabled()).resolves.toBe(false);
  });

  it("returns false when PEPA_ENABLE_DEV_TOOLS is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", "");

    await expect(devToolsEnabled()).resolves.toBe(false);
  });

  it("cannot be re-enabled by any truthy value of the flag", async () => {
    vi.stubEnv("NODE_ENV", "production");

    for (const value of ["true", "TRUE", "1", "yes"]) {
      vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", value);
      await expect(devToolsEnabled()).resolves.toBe(false);
    }
  });
});

describe("devToolsEnabled — outside production the previous behaviour is preserved", () => {
  it("returns true with the flag unset", async () => {
    vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", "");

    await expect(devToolsEnabled()).resolves.toBe(true);
  });

  it("returns true with the flag set", async () => {
    vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", "true");

    await expect(devToolsEnabled()).resolves.toBe(true);
  });

  it("returns true even with the flag explicitly false, as before", async () => {
    // Outside production the tools were always available: the old
    // `NODE_ENV !== "production" || …` expression short-circuited here, so the
    // flag never changed the outcome. Preserved exactly.
    vi.stubEnv("PEPA_ENABLE_DEV_TOOLS", "false");

    await expect(devToolsEnabled()).resolves.toBe(true);
  });

  it("returns true in development", async () => {
    vi.stubEnv("NODE_ENV", "development");

    await expect(devToolsEnabled()).resolves.toBe(true);
  });
});