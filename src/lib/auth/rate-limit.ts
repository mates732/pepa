/**
 * Login throttle.
 *
 * THIS IS NOT A SECURITY BOUNDARY. It is a UX affordance that blunts casual,
 * interactive guessing. Concretely, on the deployment PEPA actually targets:
 *
 *   * the Map is process-local — every serverless cold start begins empty, so an
 *     attacker who lets the instance recycle resets the counter for free;
 *   * concurrent instances never share it, so N instances tolerate N × 5
 *     failures before any lock engages;
 *   * the key is derived from `x-forwarded-for`, which a determined client can
 *     influence.
 *
 * Read it as "slow down a human typing the same wrong password five times", not
 * as online password-guessing resistance. A correct password is a single
 * 256-bit-plus random secret compared in constant time
 * (`verifyPassword()` in ./env.ts), and that — not this file — is what makes
 * guessing impractical.
 *
 * The real second lock is infrastructure, and it is required before PEPA faces
 * the internet: enable Vercel Authentication or an IP allow-list on the
 * production domain. See step 6 of docs/production-deployment.md. Until that is
 * in place, treat password strength as the only real barrier.
 */

const MAX_FAILURES = 5;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 30 * 60_000;

interface Entry {
  failures: number;
  lockedUntil: number;
}

const attempts = new Map<string, Entry>();

// Do not let the map grow without bound if the app is ever exposed publicly.
const MAX_TRACKED_KEYS = 5_000;

export interface LoginGate {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function loginAllowed(key: string, now: number = Date.now()): LoginGate {
  const entry = attempts.get(key);
  if (!entry || entry.lockedUntil <= now) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
  };
}

export function recordLoginFailure(key: string, now: number = Date.now()): LoginGate {
  const entry = attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  entry.failures += 1;

  if (entry.failures >= MAX_FAILURES) {
    const exponent = entry.failures - MAX_FAILURES;
    const lock = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** exponent);
    entry.lockedUntil = now + lock;
    attempts.set(key, entry);
    return { allowed: false, retryAfterSeconds: Math.ceil(lock / 1000) };
  }

  attempts.set(key, entry);
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginSuccess(key: string): void {
  attempts.delete(key);
}

/** Test-only reset. */
export function resetLoginAttempts(): void {
  attempts.clear();
}

export function trackedKeys(): number {
  return attempts.size;
}

export function enforceCapacity(key: string): void {
  if (attempts.size < MAX_TRACKED_KEYS) return;
  const oldest = attempts.keys().next();
  if (!oldest.done && oldest.value !== key) attempts.delete(oldest.value);
}