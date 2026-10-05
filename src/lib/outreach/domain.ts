/**
 * Domain normalisation — the single canonical form for outreach identity.
 *
 * `normalizeEmail()` in `src/lib/email.ts` is the identity PEPA trusts for the
 * *primary* key: an exact, normalized address. This module is the secondary
 * key. It exists because two people at one company often use two addresses,
 * and a cold pitch to the second one is still a second pitch to a company that
 * has already heard from us.
 *
 * IMPORTANT: `normalizeDomain` is a mirror of the immutable SQL function
 * `public.normalize_domain` created in
 * `supabase/migrations/20260101000600_historical_outreach.sql`. Both sides must
 * strip exactly the same characters, or the generated
 * `historical_outreach.domain_normalized` column and the application would
 * disagree about which rows a domain lookup may match. Change one, change the
 * other.
 *
 * What it does NOT do: it never claims that a domain identifies a company. See
 * `SHARED_EMAIL_PROVIDER_DOMAINS` — a gmail.com row says nothing about any other
 * gmail.com recipient, and blocking on it would refuse outreach to almost
 * everyone.
 */

/**
 * `scheme://`, anything that looks like a scheme, or a protocol-relative `//`.
 * Applied case-insensitively by the lowercase step, which runs first.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;
const PROTOCOL_RELATIVE = /^\/\//;

/** `user:pass@` before a hostname. Never part of a domain identity. */
const USER_INFO = /^[^@/]*@/;

/** `example.com:8443`. */
const PORT = /:\d+$/;

/**
 * A hostname: dot-separated labels of letters, digits and inner hyphens.
 *
 * Rejecting anything else (spaces, `@`, unicode, empty labels) is deliberate —
 * a value that is not a hostname is not a domain, and storing it as one would
 * create a phantom identity that blocks unrelated recipients.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** RFC 1035 limit. Anything longer is not a hostname. */
const MAX_DOMAIN_LENGTH = 253;

/**
 * Fold any spelling of a host to one canonical form.
 *
 * Applied in a fixed order, and the order matters:
 *   1. lowercase first, so `HTTPS://WWW.Example.CZ` is matched by the
 *      case-sensitive scheme and `WWW.` patterns below;
 *   2. strip a scheme or `//`;
 *   3. strip any `user@` prefix;
 *   4. cut at the first `/`, `?` or `#` — a domain is never a path;
 *   5. strip a port;
 *   6. strip surrounding dots (a trailing root dot is legal DNS, `bistro.cz.`);
 *   7. strip a leading `www.`;
 *   8. validate as a hostname, returning "" when it is not one.
 *
 * Returns "" rather than null so callers can treat "not a domain" as falsy
 * exactly like "no domain". The SQL mirror returns NULL for the same inputs.
 */
export function normalizeDomain(input: string | null | undefined): string {
  if (!input) return "";

  let value = String(input).trim().toLowerCase();
  if (!value) return "";

  // `<https://bistro.cz>` — the same display-name wrapper `extractAddress()`
  // strips from an address. Present here so the two identities cannot be spelled
  // apart by a stray angle bracket.
  value = value.replace(/^[<]+/, "").replace(/[>]+$/, "");
  value = value.replace(SCHEME, "").replace(PROTOCOL_RELATIVE, "");
  value = value.replace(USER_INFO, "");
  value = value.split(/[/?#]/, 1)[0] ?? "";
  value = value.replace(PORT, "");
  value = value.replace(/^\.+|\.+$/g, "");
  value = value.replace(/^www\./, "");

  if (!value || value.length > MAX_DOMAIN_LENGTH) return "";
  if (!HOSTNAME.test(value)) return "";

  return value;
}

/**
 * The domain part of an email, in canonical form. "" when the address has none.
 *
 * Convenience only: identity is still decided on the full address. This exists
 * so the domain guard reads from one place instead of re-deriving the substring.
 */
export function domainFromEmail(email: string | null | undefined): string {
  const normalized = String(email ?? "").trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return "";
  return normalizeDomain(normalized.slice(at + 1));
}

/**
 * Mailboxes that are shared by unrelated people.
 *
 * `owner1@gmail.com` and `owner2@gmail.com` are different businesses. A domain
 * guard that treated them as one company would refuse outreach to effectively
 * every prospect in the country, so these domains are never allowed to produce
 * a domain-level block.
 *
 * Entries are matched exactly after `normalizeDomain`, except for the four
 * wildcard entries below, which cover the country variants providers ship
 * (`yahoo.co.uk`, `gmx.de`, `hotmail.fr`, `outlook.de`, …) — those are the same
 * provider and the same mailbox, so one entry per family is enough.
 *
 * This list is a mirror of `public.is_shared_email_provider` in the same
 * migration as `public.normalize_domain`. Keep them in step.
 */
export const SHARED_EMAIL_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "passport.com",
  "windowslive.com",
  // Yahoo
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // Other western providers
  "aol.com",
  "gmx.de",
  "gmx.net",
  "gmx.at",
  "gmx.ch",
  "web.de",
  "mail.com",
  "mail.ru",
  "yandex.ru",
  "yandex.com",
  "zoho.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "fastmail.com",
  "tutanota.com",
  "tuta.io",
  "hushmail.com",
  "inbox.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  // Czech free mailboxes
  "seznam.cz",
  "centrum.cz",
  "volny.cz",
  "at.cz",
  "tiscali.cz",
  "o2.cz",
  "internet.cz",
  "email.cz",
  "freemail.cz",
  "posluch.net",
]);

/**
 * Provider families that ship per-country domains.
 *
 * Kept separate from the exact set so the intent is readable: a match here
 * means "the same mailbox provider under some country code", which is exactly
 * the relationship that must NOT create a domain-level block.
 */
const SHARED_EMAIL_PROVIDER_PREFIXES: readonly string[] = [
  "yahoo.",
  "ymail.",
  "gmx.",
  "hotmail.",
  "outlook.",
  "live.",
  "yandex.",
  "protonmail.",
];

/**
 * Is this domain a mailbox provider rather than a company's own domain?
 *
 * True means "a domain-level block is never allowed for this address". It does
 * not disable the address-level guard: `owner1@gmail.com` still cannot receive
 * a second cold outreach.
 */
export function isSharedEmailProviderDomain(domain: string | null | undefined): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  if (SHARED_EMAIL_PROVIDER_DOMAINS.has(normalized)) return true;
  return SHARED_EMAIL_PROVIDER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * May a domain-level block be applied to this domain?
 *
 * The single place the "shared providers must never cross-block" rule is
 * expressed. Callers that want a company-level guard ask this first; callers
 * that want the address-level guard do not need it, because an address is never
 * shared between two unrelated businesses the way a provider domain is.
 *
 * False for an unparseable domain too. There is no company identity to protect
 * without one, and treating "no domain" as "a company" would let an unusable
 * address block everyone.
 */
export function allowsDomainLevelBlock(domain: string | null | undefined): boolean {
  if (!normalizeDomain(domain)) return false;
  return !isSharedEmailProviderDomain(domain);
}