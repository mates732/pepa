/**
 * Single place that answers "is this deployment configured?".
 * Reports variable NAMES and reasons only — never values.
 *
 * Validation covers the COMPLETE documented workflow, not just the part the
 * dashboard happens to need. A deployment missing CRON_SECRET, IMPORT_SECRET or
 * a Telegram variable used to render a perfectly healthy dashboard while cron
 * answered 401 and Telegram silently did nothing — the worst possible failure
 * mode, because it looks like success. `configured` now means "every documented
 * capability can actually run".
 *
 * Grouping:
 *   supabase   NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *   auth       PEPA_PASSWORD, PEPA_SESSION_SECRET  (via getAuthEnvStatus())
 *   telegram   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET
 *   endpoints  CRON_SECRET, IMPORT_SECRET
 *   origin     PEPA_BASE_URL
 */

import "server-only";

import { AUTH_ENV_VARS, getAuthEnvStatus } from "@/lib/auth/env";
import { getSupabaseEnvStatus } from "@/lib/supabase/server";

/**
 * The notification channel and the two authenticated entry points.
 *
 * Only presence is required here. Deliberately NO minimum-length rule: inventing
 * a length policy the rest of PEPA does not enforce would reject configurations
 * that work perfectly well, and a non-empty random secret is the whole
 * requirement for a bearer comparison.
 */
const TELEGRAM_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
] as const;

const ENDPOINT_ENV_VARS = ["CRON_SECRET", "IMPORT_SECRET"] as const;

/**
 * The canonical public origin. Production deep links are built only from this
 * value and never from a request header (see src/lib/config/base-url.ts), so in
 * production it is required rather than merely recommended.
 */
const BASE_URL_VAR = "PEPA_BASE_URL";

/** Names of the required variables that are absent or blank. Never values. */
function absentNames(names: readonly string[]): string[] {
  return names.filter((name) => !process.env[name]?.trim());
}

export interface EnvStatus {
  configured: boolean;
  /** Flat list of variable NAMES that must be set. Rendered by SetupNotice. */
  missing: string[];
  /** Variable NAMES that are optional here but expected in production. */
  warnings: string[];
  detail?: string;
}

/**
 * Which of the documented variables are present.
 *
 * Public reads this and shows the setup notice. No secret ever crosses this line:
 * the result contains variable names and nothing else.
 */
export function getEnvStatus(): EnvStatus {
  const production = process.env.NODE_ENV === "production";

  const supabase = getSupabaseEnvStatus();
  const auth = getAuthEnvStatus();

  const missing = [
    ...supabase.missing,
    ...auth.missing,
    ...auth.weak,
    ...absentNames(TELEGRAM_ENV_VARS),
    ...absentNames(ENDPOINT_ENV_VARS),
  ];

  // Locally the dev server origin is a correct fallback, so a missing
  // PEPA_BASE_URL is only worth a warning. In production it is the difference
  // between a working deep link and a host-header-derived one.
  const warnings: string[] = [];
  if (!process.env[BASE_URL_VAR]?.trim()) {
    if (production) missing.push(BASE_URL_VAR);
    else warnings.push(BASE_URL_VAR);
  }

  // `configured` is deliberately stricter than "the dashboard can render": it
  // means the whole documented workflow — drafts, import, cron, Telegram — can
  // run. A partially configured deployment must not report success.
  const configured = supabase.configured && auth.configured && missing.length === 0;

  let detail: string | undefined;
  if (auth.weak.length > 0) {
    detail = `Weak configuration: ${auth.weak.join(", ")} (see .env.example for the minimums).`;
  }

  return { configured, missing, warnings, detail };
}

export { AUTH_ENV_VARS };