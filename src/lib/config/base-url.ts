import "server-only";

import { headers } from "next/headers";

/**
 * Absolute base URL for deep links.
 *
 * `PEPA_BASE_URL` always wins, so a canonical public hostname can differ from
 * the deployment host.
 *
 * In production there is NO header fallback. `x-forwarded-host` / `host` are
 * request-supplied: a poisoned or misrouted Host header would mint a deep link
 * pointing at an attacker's origin, and that link is then delivered into the
 * operator's Telegram chat. Failing closed is the only safe answer, so a
 * production deployment without `PEPA_BASE_URL` refuses to build deep links at
 * all rather than guessing.
 *
 * Outside production the request host is a correct fallback and local dev keeps
 * working without any configuration.
 */
export async function getBaseUrl(): Promise<string> {
  const explicit = process.env.PEPA_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  if (process.env.NODE_ENV === "production") {
    // Names the variable and points at the template. Never a value.
    throw new Error(
      "PEPA_BASE_URL is not configured. Production deep links are never derived from a request header. See .env.example.",
    );
  }

  const h = await headers();
  const forwardedHost = h.get("x-forwarded-host") ?? h.get("host");
  if (forwardedHost) {
    const proto = h.get("x-forwarded-proto") ?? (forwardedHost.startsWith("localhost") ? "http" : "https");
    return `${proto}://${forwardedHost}`;
  }

  return "http://localhost:3000";
}

/** Build an absolute deep link for a raw, opaque action token. */
export async function buildDeepLink(token: string): Promise<string> {
  const base = await getBaseUrl();
  return `${base}/followup/${encodeURIComponent(token)}`;
}

/**
 * Deep link for an imported draft. Same shape, different route: a token is
 * purpose-bound, so an import link cannot land on the follow-up page and a
 * follow-up link cannot land on the import page.
 */
export async function buildImportDeepLink(token: string): Promise<string> {
  const base = await getBaseUrl();
  return `${base}/import/${encodeURIComponent(token)}`;
}
