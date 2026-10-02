/**
 * Next.js 16 Proxy (formerly Middleware) — see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
 *
 * Optimistic first gate only: it reads and verifies the signed cookie without
 * touching the database, then redirects. It is NOT the security boundary —
 * `requireAuthenticatedUser()` in src/lib/auth/dal.ts re-checks on every
 * Server Action and every page render, so a bypass here grants nothing.
 */

import { NextResponse, type NextRequest } from "next/server";

import { safeRedirectPath } from "@/lib/auth/redirect";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  SESSION_RENEW_AFTER_MS,
  verifySessionToken,
} from "@/lib/auth/token";

const LOGIN_PATH = "/login";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = verifySessionToken(token);

  if (pathname === LOGIN_PATH) {
    // Already signed in: skip the login screen.
    if (session) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (!session) {
    const target = new URL(LOGIN_PATH, request.url);
    // Only same-origin paths are ever echoed back (see safeRedirectPath).
    const next = safeRedirectPath(pathname);
    if (next !== "/") target.searchParams.set("next", next);
    return NextResponse.redirect(target);
  }

  const response = NextResponse.next();

  // Sliding expiry: stateless tokens cannot be revoked, so an active session is
  // re-signed halfway through its life and a stolen cookie goes stale faster.
  if (Date.now() - session.iat * 1000 > SESSION_RENEW_AFTER_MS) {
    response.cookies.set(SESSION_COOKIE, createSessionToken(), SESSION_COOKIE_OPTIONS);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};