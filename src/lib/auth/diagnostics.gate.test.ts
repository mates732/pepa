import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authEnvDiagnostics, authDiagnosticsEnabled } from "./diagnostics";

// Prevent false positives when a secret value appears only in a reason label.
const SECRET_WORDS = new Set([
  "short",
  "missing",
  "empty",
  "configured",
  "too short",
]);

function hasLeakedSecret(surface: string, value: string): boolean {
  if (SECRET_WORDS.has(value)) return false;
  return surface.includes(value);
}

function setPassword(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_PASSWORD;
  else process.env.PEPA_PASSWORD = value;
}

function setSecret(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_SESSION_SECRET;
  else process.env.PEPA_SESSION_SECRET = value;
}

describe("authDiagnosticsEnabled", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when VERCEL_ENV is not preview", () => {
    expect(authDiagnosticsEnabled()).toBe(false);
  });

  it("returns false when VERCEL_ENV is preview but the flag is missing", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "");

    expect(authDiagnosticsEnabled()).toBe(false);
  });

  it("returns false when VERCEL_ENV is preview but the flag is not exactly \"true\"", () => {
    vi.stubEnv("VERCEL_ENV", "preview");

    for (const value of ["false", "TRUE", "1", "yes", "true "]) {
      vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", value);
      expect(authDiagnosticsEnabled()).toBe(false);
    }
  });

  it("returns true when VERCEL_ENV is preview and the flag is \"true\"", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "true");

    expect(authDiagnosticsEnabled()).toBe(true);
  });

  it("returns false in production even when the flag is \"true\"", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "true");

    expect(authDiagnosticsEnabled()).toBe(false);
  });
});

describe("authEnvDiagnostics public surface", () => {
  beforeEach(() => {
    setPassword(undefined);
    setSecret(undefined);
  });

  afterEach(() => {
    setPassword(undefined);
    setSecret(undefined);
  });

  it("never leaks secret values when diagnostics are enabled", () => {
    setPassword("SuperSecretPassword12");
    setSecret("a".repeat(32));

    const diag = authEnvDiagnostics();
    const surface = JSON.stringify(diag);

    expect(surface).not.toContain("SuperSecretPassword12");
    expect(surface).not.toContain("SuperSecret");
    expect(surface).not.toContain("Password12");
    expect(surface).not.toContain("a".repeat(32));    expect(diag.reason).toBe("configured");
  });

  it("never leaks secret values when the deployment appears unconfigured", () => {
    setPassword("a".repeat(12));
    setSecret("short");

    const diag = authEnvDiagnostics();
    const surface = JSON.stringify(diag);

    expect(hasLeakedSecret(surface, "short")).toBe(false);
    expect(diag.secretLengthValid).toBe(false);
    expect(diag.reason).toBe("PEPA_SESSION_SECRET is too short");
  });
});
