import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDeepLink,
  buildImportDeepLink,
  getBaseUrl,
} from "@/lib/config/base-url";

/** Mutable header bag, mirroring the next/headers mock in src/lib/auth/dal.test.ts. */
const headerStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => headerStore.get(name) ?? null,
  }),
}));

const TOKEN = "fp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PEPA_BASE_URL", "");
  headerStore.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getBaseUrl — PEPA_BASE_URL wins", () => {
  it("prefers PEPA_BASE_URL over the forwarded host", async () => {
    vi.stubEnv("PEPA_BASE_URL", "https://pepa.example.com");
    headerStore.set("x-forwarded-host", "internal.vercel.app");
    headerStore.set("host", "internal.vercel.app");

    await expect(getBaseUrl()).resolves.toBe("https://pepa.example.com");
  });

  it("prefers PEPA_BASE_URL over a plain host header", async () => {
    vi.stubEnv("PEPA_BASE_URL", "https://pepa.example.com");
    headerStore.set("host", "attacker.example.net");

    await expect(getBaseUrl()).resolves.toBe("https://pepa.example.com");
  });

  it("strips trailing slashes, exactly as before", async () => {
    vi.stubEnv("PEPA_BASE_URL", "https://pepa.example.com///");

    await expect(getBaseUrl()).resolves.toBe("https://pepa.example.com");
  });

  it("trims surrounding whitespace before using the value", async () => {
    vi.stubEnv("PEPA_BASE_URL", "  https://pepa.example.com  ");

    await expect(getBaseUrl()).resolves.toBe("https://pepa.example.com");
  });

  it("still wins in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PEPA_BASE_URL", "https://pepa.example.com");
    headerStore.set("host", "internal.vercel.app");

    await expect(getBaseUrl()).resolves.toBe("https://pepa.example.com");
  });
});

describe("getBaseUrl — production fails closed", () => {
  it("throws instead of trusting x-forwarded-host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    headerStore.set("x-forwarded-host", "attacker.example.net");
    headerStore.set("x-forwarded-proto", "https");

    await expect(getBaseUrl()).rejects.toThrow(/PEPA_BASE_URL/);
  });

  it("throws instead of trusting a plain host header", async () => {
    vi.stubEnv("NODE_ENV", "production");
    headerStore.set("host", "attacker.example.net");

    await expect(getBaseUrl()).rejects.toThrow(/PEPA_BASE_URL/);
  });

  it("points the operator at .env.example", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(getBaseUrl()).rejects.toThrow(/\.env\.example/);
  });

  it("never returns a header-derived origin in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    headerStore.set("x-forwarded-host", "attacker.example.net");

    await expect(getBaseUrl()).rejects.toThrow();
  });

  it("treats a whitespace-only PEPA_BASE_URL as unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PEPA_BASE_URL", "   ");
    headerStore.set("host", "attacker.example.net");

    await expect(getBaseUrl()).rejects.toThrow(/PEPA_BASE_URL/);
  });

  it("surfaces through buildDeepLink and buildImportDeepLink too", async () => {
    vi.stubEnv("NODE_ENV", "production");
    headerStore.set("host", "attacker.example.net");

    await expect(buildDeepLink(TOKEN)).rejects.toThrow(/PEPA_BASE_URL/);
    await expect(buildImportDeepLink(TOKEN)).rejects.toThrow(/PEPA_BASE_URL/);
  });
});

describe("getBaseUrl — local development is unaffected", () => {
  it("falls back to x-forwarded-host", async () => {
    headerStore.set("x-forwarded-host", "dev.local");
    headerStore.set("x-forwarded-proto", "http");

    await expect(getBaseUrl()).resolves.toBe("http://dev.local");
  });

  it("falls back to a plain host header", async () => {
    headerStore.set("host", "localhost:3000");

    await expect(getBaseUrl()).resolves.toBe("http://localhost:3000");
  });

  it("assumes https for a non-localhost forwarded host", async () => {
    headerStore.set("x-forwarded-host", "staging.example.com");

    await expect(getBaseUrl()).resolves.toBe("https://staging.example.com");
  });

  it("falls back to localhost when no header is present", async () => {
    await expect(getBaseUrl()).resolves.toBe("http://localhost:3000");
  });
});

describe("deep-link URL shapes are unchanged", () => {
  it("keeps /followup/<token>", async () => {
    vi.stubEnv("PEPA_BASE_URL", "https://pepa.example.com");

    await expect(buildDeepLink(TOKEN)).resolves.toBe(
      `https://pepa.example.com/followup/${TOKEN}`,
    );
  });

  it("keeps /import/<token>", async () => {
    vi.stubEnv("PEPA_BASE_URL", "https://pepa.example.com");

    await expect(buildImportDeepLink(TOKEN)).resolves.toBe(
      `https://pepa.example.com/import/${TOKEN}`,
    );
  });

  it("still encodes the token in the path segment", async () => {
    vi.stubEnv("PEPA_BASE_URL", "https://pepa.example.com");

    await expect(buildDeepLink("fp1_a/b")).resolves.toBe(
      "https://pepa.example.com/followup/fp1_a%2Fb",
    );
  });
});