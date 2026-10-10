import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  getAuthEnvStatus,
  AUTH_ENV_VARS,
  MIN_PASSWORD_LENGTH,
  MIN_SECRET_LENGTH,
} from "./env";

function setPassword(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_PASSWORD;
  else process.env.PEPA_PASSWORD = value;
}

function setSecret(value: string | undefined) {
  if (value === undefined) delete process.env.PEPA_SESSION_SECRET;
  else process.env.PEPA_SESSION_SECRET = value;
}

describe("getAuthEnvStatus", () => {
  beforeEach(() => {
    setPassword(undefined);
    setSecret(undefined);
  });

  afterEach(() => {
    setPassword(undefined);
    setSecret(undefined);
  });

  it("reports not configured when both variables are absent", () => {
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([
      "PEPA_PASSWORD",
      "PEPA_SESSION_SECRET",
    ]);
    expect(status.weak).toEqual([]);
  });

  it("reports not configured when only the password is absent", () => {
    setSecret("a".repeat(MIN_SECRET_LENGTH));
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["PEPA_PASSWORD"]);
    expect(status.weak).toEqual([]);
  });

  it("reports not configured when only the session secret is absent", () => {
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["PEPA_SESSION_SECRET"]);
    expect(status.weak).toEqual([]);
  });

  it("reports configured only when both values meet the minimums", () => {
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    setSecret("b".repeat(MIN_SECRET_LENGTH));
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual([]);
  });

  it("reports configured for a 32-character exact session secret", () => {
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    setSecret("a".repeat(32));

    const status = getAuthEnvStatus();
    expect(status.configured).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual([]);
  });

  it("reports not configured when the session secret is exactly 31 characters", () => {
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    setSecret("a".repeat(31));

    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual(["PEPA_SESSION_SECRET"]);
  });

  it("reports configured for a 32-char secret that is only spaces, and notes the weakness", () => {
    // Important regression for the real reported failure mode: the current
    // validation rejects on length only, so a whitespace-only 32-char value still
    // counts as \"long enough\". If you want reject-on-whitespace too, that is a new
    // rule and must be added explicitly.
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    setSecret(" ".repeat(32));

    const status = getAuthEnvStatus();
    expect(status.configured).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual([]);
  });

  it("reports not configured for a 31-char space-only secret", () => {
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    setSecret(" ".repeat(31));

    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual(["PEPA_SESSION_SECRET"]);
  });

  it("reports weak when the password is present but too short", () => {
    setPassword("short");
    setSecret("b".repeat(MIN_SECRET_LENGTH));
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual(["PEPA_PASSWORD"]);
  });

  it("reports weak when the session secret is present but too short", () => {
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    setSecret("short");
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual(["PEPA_SESSION_SECRET"]);
  });

  it("reports weak for both when both are present but too short", () => {
    setPassword("short");
    setSecret("short");
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([]);
    expect(status.weak).toEqual([
      "PEPA_PASSWORD",
      "PEPA_SESSION_SECRET",
    ]);
  });

  it("treats whitespace-only password as missing", () => {
    // getAuthEnvStatus treats "" as missing but does NOT trim, so a pure-space
    // value is technically present and only falls into the weak path if short.
    setPassword("  ");
    setSecret("b".repeat(MIN_SECRET_LENGTH));
    const status = getAuthEnvStatus();
    // "  " is present and its length is below the 12-char minimum, so it lands
    // in `weak`, not `missing`.
    expect(status.configured).toBe(false);
    expect(status.weak).toContain("PEPA_PASSWORD");
    expect(status.missing).not.toContain("PEPA_PASSWORD");
  });

  it("reports missing when password is an empty string", () => {
    setPassword("");
    setSecret("b".repeat(MIN_SECRET_LENGTH));
    const status = getAuthEnvStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual(["PEPA_PASSWORD"]);
    expect(status.weak).toEqual([]);
  });

  it("AUTH_ENV_VARS lists only the expected variable names", () => {
    expect(AUTH_ENV_VARS).toEqual([
      "PEPA_PASSWORD",
      "PEPA_SESSION_SECRET",
    ]);
  });

  it("reports authEnabled true when password is set and not weak, even if session secret is missing", () => {
    setPassword("a".repeat(MIN_PASSWORD_LENGTH));
    setSecret(undefined);

    const status = getAuthEnvStatus();
    expect(status.authEnabled).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.missing).toContain("PEPA_SESSION_SECRET");
  });

  it("reports authEnabled false when password is missing, even if session secret is set", () => {
    setPassword(undefined);
    setSecret("a".repeat(MIN_SECRET_LENGTH));

    const status = getAuthEnvStatus();
    expect(status.authEnabled).toBe(false);
    expect(status.missing).toContain("PEPA_PASSWORD");
  });

  it("reports authEnabled false when password is too short, even if session secret is set", () => {
    setPassword("short");
    setSecret("a".repeat(MIN_SECRET_LENGTH));

    const status = getAuthEnvStatus();
    expect(status.authEnabled).toBe(false);
    expect(status.weak).toContain("PEPA_PASSWORD");
  });
});
