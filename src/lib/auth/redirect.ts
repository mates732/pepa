/**
 * Defence in depth for redirects: only same-origin, single-slash paths are
 * accepted, so a `?next=` parameter can never become an open redirect.
 *
 * Pure module — imported by both Proxy and the Data Access Layer.
 */
export function safeRedirectPath(
  candidate: string | null | undefined,
  fallback = "/",
): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback;
  if (candidate.includes("\\") || candidate.includes("://")) return fallback;
  return candidate;
}