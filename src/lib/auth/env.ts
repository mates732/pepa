/**
 * Auth environment configuration.
 *
 * Only names and validity are reported — never values. Nothing here is prefixed
 * with NEXT_PUBLIC_ and nothing may be imported from a client component.
 */

import "server-only";

import { constantTimeEquals } from "./token";

export const AUTH_ENV_VARS = ["PEPA_PASSWORD", "PEPA_SESSION_SECRET"] as const;

/** PEPA must never run on a trivially guessable password. */
export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SECRET_LENGTH = 32;

export interface AuthEnvStatus {
  configured: boolean;
  missing: string[];
  /** Set when a variable is present but too weak to be safe. */
  weak: string[];
  /** True when password-based login can run, even if other capabilities are missing. */
  authEnabled: boolean;
}

export function getAuthEnvStatus(): AuthEnvStatus {
  const missing: string[] = [];
  const weak: string[] = [];

  const password = process.env.PEPA_PASSWORD;
  if (!password) missing.push("PEPA_PASSWORD");
  else if (password.length < MIN_PASSWORD_LENGTH) weak.push("PEPA_PASSWORD");

  const secret = process.env.PEPA_SESSION_SECRET;
  if (!secret) missing.push("PEPA_SESSION_SECRET");
  else if (secret.length < MIN_SECRET_LENGTH) weak.push("PEPA_SESSION_SECRET");

  // Auth-only check: the login page only needs password verification to run.
  // Session signing is validated directly in token.ts when a cookie is created,
  // so a missing/bad session secret must not disable the login screen itself.
  const authEnabled = !missing.includes("PEPA_PASSWORD") && weak.length === 0;

  return {
    configured: missing.length === 0 && weak.length === 0,
    missing,
    weak,
    authEnabled,
  };
}

/** Only used on the server when a genuinely valid password is presented. */
export function verifyPassword(candidate: string | null | undefined): boolean {
  const expected = process.env.PEPA_PASSWORD;
  if (!expected || expected.length < MIN_PASSWORD_LENGTH) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  // Constant-time compare, so the password cannot be recovered byte by byte.
  return constantTimeEquals(candidate, expected);
}