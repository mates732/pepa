import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export type SupabaseEnvStatus = {
  configured: boolean;
  missing: string[];
  url: string | null;
};

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/** Which of the required variables are present. Safe to call anywhere on the server. */
export function getSupabaseEnvStatus(): SupabaseEnvStatus {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  return {
    configured: missing.length === 0,
    missing,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
  };
}

/**
 * Server-side Supabase client using the service-role key.
 *
 * All outreach traffic goes through this client, so RLS stays locked down and
 * duplicate detection lives in Postgres rather than in the browser. The key
 * must never reach the client bundle — never import this file from a
 * "use client" component.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const status = getSupabaseEnvStatus();
  if (!status.configured) {
    throw new Error(
      `Supabase is not configured. Missing environment variable(s): ${status.missing.join(", ")}. See .env.example.`,
    );
  }

  cached = createClient(
    status.url as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "outreach-tool" } },
    },
  );

  return cached;
}