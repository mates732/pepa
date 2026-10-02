/**
 * Single place that answers "is this deployment configured?".
 * Reports variable NAMES and reasons only — never values.
 */

import "server-only";

import { AUTH_ENV_VARS, getAuthEnvStatus } from "@/lib/auth/env";
import { getSupabaseEnvStatus } from "@/lib/supabase/server";

export interface EnvStatus {
  configured: boolean;
  missing: string[];
  detail?: string;
}

/** Public reads it and shows the setup notice; no secret ever crosses this line. */
export function getEnvStatus(): EnvStatus {
  const supabase = getSupabaseEnvStatus();
  const auth = getAuthEnvStatus();

  const missing = [...supabase.missing, ...auth.missing, ...auth.weak];
  const configured = supabase.configured && auth.configured;

  let detail: string | undefined;
  if (auth.weak.length > 0) {
    detail = `Weak configuration: ${auth.weak.join(", ")} (see .env.example for the minimums).`;
  }

  return { configured, missing, detail };
}

export { AUTH_ENV_VARS };