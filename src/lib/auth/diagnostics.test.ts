import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { authEnvDiagnostics } from "./diagnostics";

function setPassword(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_PASSWORD;
  else process.env.PEPA_PASSWORD = value;
}

function setSecret(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_SESSION_SECRET;
  else process.env.PEPA_SESSION_SECRET = value;
}

describe("authEnvDiagnostics", () => {
  beforeEach(() => {
    setPassword(undefined);
    setSecret(undefined);
  });

  afterEach(() => {
    setPassword(undefined);
    setSecret(undefined);
  });

  it("reports phase and passwordPresent false when password is unset", () => {
    const diag = authEnvDiagnostics();
    expect(diag.phase).toBe("request-runtime");
    expect(diag.passwordPresent).toBe(false);
    expect(diag.passwordLengthValid).toBe(false);
    expect(diag.secretPresent).toBe(false);
    expect(diag.secretLengthValid).toBe(false);
    expect(diag.configured).toBe(false);
    expect(diag.reason).toBe("PEPA_PASSWORD is missing or empty");
  });

  it("reports false when password is present but too short", () => {
    setPassword("short");
    const diag = authEnvDiagnostics();
    expect(diag.passwordPresent).toBe(true);
    expect(diag.passwordLengthValid).toBe(false);
    expect(diag.configured).toBe(false);
    expect(diag.reason).toBe("PEPA_PASSWORD is too short");
  });

  it("reports false when password meets minimum but secret is too short", () => {
    setPassword("a".repeat(12));
    setSecret("short");
    const diag = authEnvDiagnostics();
    expect(diag.passwordPresent).toBe(true);
    expect(diag.passwordLengthValid).toBe(true);
    expect(diag.secretPresent).toBe(true);
    expect(diag.secretLengthValid).toBe(false);
    expect(diag.configured).toBe(false);
    expect(diag.reason).toBe("PEPA_SESSION_SECRET is too short");
  });

  it("reports true only when both variables meet the minimums", () => {
    setPassword("a".repeat(12));
    setSecret("b".repeat(32));
    const diag = authEnvDiagnostics();
    expect(diag.passwordPresent).toBe(true);
    expect(diag.passwordLengthValid).toBe(true);
    expect(diag.secretPresent).toBe(true);
    expect(diag.secretLengthValid).toBe(true);
    expect(diag.configured).toBe(true);
    expect(diag.reason).toBe("configured");
  });

  it("never leaks any variable value in its public surface", () => {
    setPassword("SuperSecretPassword12");
    setSecret("a".repeat(32));
    const diag = authEnvDiagnostics();
    const publicSurface = JSON.stringify(diag);
    expect(publicSurface).not.toContain("SuperSecretPassword12");
    expect(publicSurface).not.toContain("SuperSecret");
    expect(publicSurface).not.toContain("Password12");
  });

  it("treats empty string password as missing", () => {
    setPassword("");
    const diag = authEnvDiagnostics();
    expect(diag.passwordPresent).toBe(false);
    expect(diag.reason).toBe("PEPA_PASSWORD is missing or empty");
  });
});
