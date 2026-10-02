import "server-only";

import { headers } from "next/headers";

/**
 * Absolute base URL for deep links.
 *
 * On Vercel and behind any proxy the forwarded host is authoritative. On local
 * dev it falls back to the dev server origin. `PEPA_BASE_URL` overrides both when
 * a canonical public hostname differs from the deployment host.
 */
export async function getBaseUrl(): Promise<string> {
  const explicit = process.env.PEPA_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

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
