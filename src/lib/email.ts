/**
 * Email normalisation.
 *
 * IMPORTANT: `normalizeEmail` is a mirror of the immutable SQL function
 * `public.normalize_email` created in
 * `supabase/migrations/00000000000001_init.sql`. Both sides must strip exactly
 * the same character class, otherwise the application and the database unique
 * index would disagree about what counts as a duplicate.
 */

const NON_EMAIL_EDGE = /^[^A-Za-z0-9._%+-]+|[^A-Za-z0-9._%+-]+$/g;

/** Strip optional `Name <user@host.tld>` wrappers and surrounding noise. */
export function extractAddress(input: string): string {
  const bracketed = input.match(/<([^<>]+)>/);
  return (bracketed ? bracketed[1] : input).trim();
}

/** Trim, unwrap, lowercase and strip surrounding punctuation from an email. */
export function normalizeEmail(input: string | null | undefined): string {
  if (!input) return "";
  return extractAddress(String(input))
    .trim()
    .replace(NON_EMAIL_EDGE, "")
    .toLowerCase();
}

const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function isValidEmail(input: string | null | undefined): boolean {
  return EMAIL_SHAPE.test(normalizeEmail(input));
}