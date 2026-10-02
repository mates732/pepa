/**
 * Deep-link action tokens.
 *
 * A token is an opaque, single-purpose reference to a PEPA resource. It carries
 * no lead id, no email, no subject and no body — only random bytes plus a
 * purpose tag, so possessing one cannot be used to enumerate or guess leads.
 *
 * Storage rule: only `hashActionToken(raw)` is ever persisted. Presentation
 * rule: the raw token appears solely inside the Telegram button URL.
 *
 * Pure module: no `next/*` imports, safe to unit test directly.
 */

import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ACTION_TOKEN_PURPOSES = ["followup_composer", "outreach_import"] as const;
export type ActionTokenPurpose = (typeof ACTION_TOKEN_PURPOSES)[number];

/** Visible prefix: makes leaked tokens identifiable and purpose-scannable. */
const TOKEN_PREFIX = "fp1";

/** 32 random bytes -> 43 base64url characters. */
const TOKEN_BYTES = 32;

export const TOKEN_PATTERN = /^fp1_[A-Za-z0-9_-]{43}$/;

/** Default lifetime. Long enough for a mobile round-trip, short enough to expire. */
export const DEFAULT_ACTION_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72h

/**
 * Import links are deliberately much shorter-lived.
 *
 * A follow-up link is a notification the operator may tap hours later. An import
 * link points at a payload that was just pasted in and is reviewed immediately,
 * so a 30-minute window is plenty — and shrinking it shrinks the value of a
 * leaked link.
 */
export const IMPORT_TOKEN_TTL_MS = 30 * 60 * 1000; // 30m

/**
 * Domain separation: the same signing key is never reused for the session
 * cookie, so a token digest can never be mistaken for (or used to forge) a
 * session token, and vice versa.
 */
const HASH_DOMAIN = "pepa:action-token:v1:";

/** Fresh random token. The only time the raw value exists outside memory. */
export function generateActionToken(): string {
  return `${TOKEN_PREFIX}_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

export function isActionTokenFormat(value: string | null | undefined): boolean {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function signingKey(): string | null {
  const secret = process.env.PEPA_SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

/**
 * Deterministic digest of a raw token.
 *
 * HMAC (not a bare hash) so that even someone holding the whole table cannot
 * confirm a guessed token without the server-side key.
 */
export function hashActionToken(rawToken: string): string {
  const key = signingKey();
  if (!key) {
    throw new Error("PEPA_SESSION_SECRET is missing or shorter than 32 characters.");
  }
  return createHmac("sha256", key)
    .update(`${HASH_DOMAIN}${rawToken}`, "utf8")
    .digest("hex");
}

/** Constant-time digest comparison, for defence in depth at the boundary. */
export function tokenDigestsMatch(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function expiresAt(from: number = Date.now(), ttlMs = DEFAULT_ACTION_TOKEN_TTL_MS): Date {
  return new Date(from + ttlMs);
}

export function isExpired(expiresAtIso: string, now: number = Date.now()): boolean {
  const value = Date.parse(expiresAtIso);
  return Number.isNaN(value) || value <= now;
}