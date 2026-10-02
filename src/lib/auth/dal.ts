/**
 * Data Access Layer for authentication.
 *
 * Every privileged server function must go through this module *before*
 * touching Supabase. `verifySession()` protects pages (redirects), and
 * `requireAuthenticatedUser()` protects mutations (throws).
 */

import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/token";
import type { SessionPayload } from "@/lib/auth/token";

export const LOGIN_PATH = "/login";

export class AuthenticationError extends Error {
  constructor(message = "Not authenticated.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface AuthenticatedUser {
  /** Stable id for the single authorized operator. */
  id: "owner";
  since: number;
}

/** Read and verify the session from the request cookies. Null when signed out. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/**
 * Page guard: redirects to /login when there is no valid session.
 * Memoized so a render pass verifies the HMAC once.
 */
export const verifySession = cache(async (): Promise<AuthenticatedUser> => {
  const session = await getSession();
  if (!session) redirect(LOGIN_PATH);
  return { id: "owner", since: session.iat };
});

/**
 * Mutation guard for Server Actions, Route Handlers and services.
 * Throws instead of returning a value, so no caller can forget to check it.
 */
export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const session = await getSession();
  if (!session) throw new AuthenticationError();
  return { id: "owner", since: session.iat };
}

/** Non-throwing variant for call sites that want to branch instead. */
export async function currentUser(): Promise<AuthenticatedUser | null> {
  const session = await getSession();
  return session ? { id: "owner", since: session.iat } : null;
}

export { safeRedirectPath } from "@/lib/auth/redirect";