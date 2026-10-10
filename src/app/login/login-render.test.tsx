import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authEnvDiagnostics, authDiagnosticsEnabled } from "@/lib/auth/diagnostics";

function setPassword(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_PASSWORD;
  else process.env.PEPA_PASSWORD = value;
}
function setSecret(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_SESSION_SECRET;
  else process.env.PEPA_SESSION_SECRET = value;
}

describe("login page diagnostic rendering contract", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "");
    setPassword(undefined);
    setSecret(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setPassword(undefined);
    setSecret(undefined);
  });

  it("renders the diagnostic when VERCEL_ENV is preview and the flag is \"true\"", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "true");

    setPassword("".padEnd(12, "a"));
    setSecret("".padEnd(32, "b"));

    const diag = authEnvDiagnostics();
    const enabled = authDiagnosticsEnabled();

    expect(enabled).toBe(true);
    expect(diag).toBeDefined();
    expect(diag.configured).toBe(true);
    expect(diag.passwordPresent).toBe(true);
    expect(diag.secretPresent).toBe(true);
    expect(diag.passwordLengthValid).toBe(true);
    expect(diag.secretLengthValid).toBe(true);

    const diagnosticText = [
      "phase: " + diag.phase,
      "passwordPresent: " + diag.passwordPresent,
      "passwordLengthValid: " + diag.passwordLengthValid,
      "secretPresent: " + diag.secretPresent,
      "secretLengthValid: " + diag.secretLengthValid,
      "configured: " + diag.configured,
      "reason: " + diag.reason,
    ].join("\n");

    expect(diagnosticText).toContain("passwordPresent: true");
    expect(diagnosticText).toContain("secretPresent: true");
    expect(diagnosticText).toContain("configured: true");
  });

  it("does not render the diagnostic when the flag is missing in preview", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "");

    expect(authDiagnosticsEnabled()).toBe(false);
  });

  it("does not render the diagnostic in production even when the flag is \"true\"", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "true");

    expect(authDiagnosticsEnabled()).toBe(false);
    expect(authEnvDiagnostics()).toBeDefined();
  });

  it("does not leak any secret value in the rendered diagnostic text", () => {
    setPassword("SuperSecretPassword12");
    setSecret("a".repeat(32));

    const diag = authEnvDiagnostics();
    const surface = JSON.stringify(diag);

    expect(surface).not.toContain("SuperSecretPassword12");
    expect(surface).not.toContain("SuperSecret");
    expect(surface).not.toContain("Password12");    expect(surface).not.toContain("a".repeat(32));
  });

  it("contains no secret-derived text even when diagnostics are enabled in preview", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PEPA_ENABLE_AUTH_DIAGNOSTICS", "true");

    setPassword("a".padEnd(12, "x"));
    setSecret("b".padEnd(32, "y"));

    const diag = authEnvDiagnostics();
    const lines = [
      "phase: " + diag.phase,
      "passwordPresent: " + diag.passwordPresent,
      "passwordLengthValid: " + diag.passwordLengthValid,
      "secretPresent: " + diag.secretPresent,
      "secretLengthValid: " + diag.secretLengthValid,
      "configured: " + diag.configured,
      "reason: " + diag.reason,
    ];

    for (const line of lines) {
      expect(line).not.toContain("xxxxxxxxxxxx");
      expect(line).not.toContain("yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy");
    }
  });
})
;

