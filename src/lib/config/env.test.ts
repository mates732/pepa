import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnvStatus } from "@/lib/config/env";

/**
 * Environment validation. Every value here is a DUMMY string written by the
 * test itself — no real credential is used or needed.
 */

/** Dummy values, distinctive enough that a leak would be unmistakable. */
const DUMMY: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://dummy-project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy-anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role-key-value",
  PEPA_PASSWORD: "dummy-password-12chars",
  PEPA_SESSION_SECRET: "dummy-session-secret-at-least-32-chars-long",
  TELEGRAM_BOT_TOKEN: "111111111:dummy-bot-token-value",
  TELEGRAM_CHAT_ID: "4242424242",
  TELEGRAM_WEBHOOK_SECRET: "dummy-webhook-secret-value",
  CRON_SECRET: "dummy-cron-secret-value",
  IMPORT_SECRET: "dummy-import-secret-value",
  PEPA_BASE_URL: "https://dummy-pepa.example.com",
};

const ALL_VARS = Object.keys(DUMMY);

/** Set every documented variable to its dummy value. */
function setEverything(): void {
  for (const name of ALL_VARS) vi.stubEnv(name, DUMMY[name] as string);
}

/** Set everything, then blank exactly one variable. */
function setAllExcept(blanked: string): void {
  setEverything();
  vi.stubEnv(blanked, "");
}

beforeEach(() => {
  // Start from a known state: NODE_ENV is "test" unless a test says otherwise.
  vi.stubEnv("NODE_ENV", "test");
  for (const name of ALL_VARS) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getEnvStatus — all eleven documented variables", () => {
  it("reports nothing missing when every variable is set", () => {
    setEverything();

    const status = getEnvStatus();

    expect(status.missing).toEqual([]);
    expect(status.configured).toBe(true);
  });

  it.each([
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PEPA_PASSWORD",
    "PEPA_SESSION_SECRET",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_WEBHOOK_SECRET",
    "CRON_SECRET",
    "IMPORT_SECRET",
  ])("surfaces the variable name when %s is missing", (name) => {
    setAllExcept(name);

    const status = getEnvStatus();

    expect(status.missing).toContain(name);
    expect(status.configured).toBe(false);
  });

  // Task 1 rule 11: required in production, only a warning locally.
  it("treats a missing PEPA_BASE_URL as required in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    setAllExcept("PEPA_BASE_URL");

    const status = getEnvStatus();

    expect(status.missing).toContain("PEPA_BASE_URL");
    expect(status.warnings).not.toContain("PEPA_BASE_URL");
    expect(status.configured).toBe(false);
  });

  it("treats a missing PEPA_BASE_URL as a warning outside production", () => {
    setAllExcept("PEPA_BASE_URL");

    const status = getEnvStatus();

    expect(status.missing).not.toContain("PEPA_BASE_URL");
    expect(status.warnings).toContain("PEPA_BASE_URL");
    // The local dev server origin is a legitimate fallback.
    expect(status.configured).toBe(true);
  });

  it("reports no warnings once PEPA_BASE_URL is set", () => {
    setEverything();

    expect(getEnvStatus().warnings).toEqual([]);
  });

  it("treats a whitespace-only variable as missing", () => {
    setAllExcept("CRON_SECRET");
    vi.stubEnv("CRON_SECRET", "   ");

    expect(getEnvStatus().missing).toContain("CRON_SECRET");
  });

  it("keeps `missing` a flat array of names, so SetupNotice renders it", () => {
    vi.stubEnv("NODE_ENV", "production");

    const { missing } = getEnvStatus();

    for (const entry of missing) {
      expect(typeof entry).toBe("string");
      expect(entry).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("getEnvStatus — configured means the whole workflow", () => {
  it("is not configured when only Telegram is missing", () => {
    setAllExcept("TELEGRAM_BOT_TOKEN");

    // Guards the original defect: cron/import/Telegram used to look healthy.
    expect(getEnvStatus().configured).toBe(false);
  });

  it("is not configured when only the cron secret is missing", () => {
    setAllExcept("CRON_SECRET");

    expect(getEnvStatus().configured).toBe(false);
  });

  it("is not configured when only the import secret is missing", () => {
    setAllExcept("IMPORT_SECRET");

    expect(getEnvStatus().configured).toBe(false);
  });
});

describe("getEnvStatus — auth policy is reused, not duplicated", () => {
  it("still enforces the 12-character password minimum via `detail`", () => {
    setEverything();
    vi.stubEnv("PEPA_PASSWORD", "short");

    const status = getEnvStatus();

    expect(status.configured).toBe(false);
    expect(status.detail).toContain("PEPA_PASSWORD");
  });

  it("still enforces the 32-character session-secret minimum", () => {
    setEverything();
    vi.stubEnv("PEPA_SESSION_SECRET", "too-short");

    const status = getEnvStatus();

    expect(status.configured).toBe(false);
    expect(status.missing).toContain("PEPA_SESSION_SECRET");
  });
});

describe("getEnvStatus — never leaks a value", () => {
  it("contains no secret value anywhere in the returned object", () => {
    setEverything();
    // Force every branch that composes text at once.
    vi.stubEnv("PEPA_PASSWORD", "short");

    const serialized = JSON.stringify(getEnvStatus());

    for (const value of Object.values(DUMMY)) {
      expect(serialized).not.toContain(value);
    }
  });

  it("reports names only, never a URL or key fragment, when Supabase is absent", () => {
    const status = getEnvStatus();

    expect(status.missing).toEqual(
      expect.arrayContaining(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]),
    );
    for (const entry of status.missing) expect(entry).not.toContain("://");
  });
});