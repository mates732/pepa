import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { constantTimeEquals } from "@/lib/auth/token";
import { processDueFollowUps } from "@/lib/services/follow-up-service";

/**
 * Follow-up scheduler — Vercel Cron compatible.
 *
 * Authorization is Vercel's standard mechanism: the cron request carries
 * `Authorization: Bearer ${CRON_SECRET}`. Failing the comparison (or the
 * secret being unset) returns 401 with no detail, so this cannot be used as an
 * oracle and cannot be triggered anonymously.
 *
 * `/api/*` is excluded from the Proxy matcher on purpose (the Telegram webhook
 * shares that exclusion), so this route owns its own authentication.
 *
 * Response contains counts only: never a token, email, subject or body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Telegram delivery must not be cut short by a short serverless timeout.
export const maxDuration = 60;

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function isAuthorizedCronRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  return constantTimeEquals(match[1].trim(), secret);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCronRequest(request)) return unauthorized();

  try {
    const outcome = await processDueFollowUps();
    return NextResponse.json({
      ok: true,
      ...outcome,
      processed_at: new Date().toISOString(),
    });
  } catch (error) {
    // Never echo the underlying message: it can contain Supabase/Telegram detail.
    console.error("follow-up scheduler failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false, error: "scheduler_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET. Refuse other verbs explicitly.
export async function POST(): Promise<NextResponse> {
  return unauthorized();
}