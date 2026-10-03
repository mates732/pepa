/**
 * Session token primitives.
 *
 * Pure crypto — no `next/*` imports — so it can be used from Proxy (edge of
 * the request lifecycle), Server Components, Server Actions and unit tests.
 *
 * Token format: `v1.<base64url(payload)>.<base64url(HMAC-SHA256(body))>`
 * Stateless, signed with PEPA_SESSION_SECRET, verified on every request.
 */

import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "pepa_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Single source of truth for cookie attributes, shared by the Server Action
 * that issues the cookie and by Proxy when it slides the expiry.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
} as const;

/**
 * Renew once the session is older than its half-life (15 days of the 30-day
 * TTL), keeping an active operator signed in. Written in ms explicitly so the
 * relationship to SESSION_TTL_SECONDS is obvious rather than arithmetic to
 * reverse-engineer.
 */
export const SESSION_RENEW_AFTER_MS = SESSION_TTL_SECONDS * 1000 * 0.5;

const TOKEN_VERSION = "v1";

export interface SessionPayload {
  v: 1;
  /** issued at, seconds since epoch */
  iat: number;
  /** expires at, seconds since epoch */
  exp: number;
}

function digest(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

/** Constant-time string comparison (length-independent via hashing). */
export function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function secret(): string | null {
  const value = process.env.PEPA_SESSION_SECRET;
  return value && value.length >= 32 ? value : null;
}

function sign(body: string): string {
  const key = secret();
  if (!key) throw new Error("PEPA_SESSION_SECRET is missing or shorter than 32 characters.");
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

/** Issue a signed session token. Fails closed if the secret is not configured. */
export function createSessionToken(now: number = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = { v: 1, iat: issuedAt, exp: issuedAt + SESSION_TTL_SECONDS };
  const body = `${TOKEN_VERSION}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${body}.${sign(body)}`;
}

/**
 * Verify a token's signature and expiry. Returns null for anything malformed,
 * tampered with, signed with another secret, or expired.
 */
export function verifySessionToken(
  token: string | undefined | null,
  now: number = Date.now(),
): SessionPayload | null {
  if (!token) return null;
  if (!secret()) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, encoded, signature] = parts;
  if (version !== TOKEN_VERSION || !encoded || !signature) return null;

  const expected = sign(`${version}.${encoded}`);
  if (!constantTimeEquals(signature, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload?.exp !== "number" || typeof payload?.iat !== "number") return null;
  if (payload.exp * 1000 <= now) return null;

  return payload;
}