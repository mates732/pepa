/**
 * Login throttle.
 *
 * Deliberately in-process: PEPA is a single-user private app, so this only has
 * to blunt online guessing. It is NOT a security boundary — it resets on a cold
 * start or a serverless instance recycle. Documented as such on purpose.
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