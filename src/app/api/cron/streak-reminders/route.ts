import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { constantTimeEquals } from "@/lib/auth/token";
import { processStreakReminder } from "@/lib/services/streak-reminder-service";

/**
 * The 19:00 streak reminder scheduler — Vercel Cron compatible.
 *
 * Authorization is Vercel's standard mechanism, identical to the follow-up
 * scheduler: the cron request carries `Authorization: Bearer ${CRON_SECRET}`,
 * and failing the comparison (or the secret being unset) returns 401 with no
 * detail. `/api/*` is excluded from the Proxy matcher, so this route owns its
 * own authentication.
 *
 * WHY MORE THAN ONE DAILY RUN
 *
 * The deadline is 19:00 in the operator's calendar (Europe/Prague), but cron
 * schedules are UTC. The offset between the two changes twice a year, so no
 * single UTC hour is 19:00 local all year. The GitHub Actions schedule in
 * `.github/workflows/streak-reminder.yml` therefore runs this route at 17:00,
 * 18:00 and 19:00 UTC: in summer the 17:00 run is the 19:00 local deadline, in
 * winter it is the 18:00 run, and the third is a same-evening retry window if
 * delivery failed. Vercel Cron is kept only as a once-a-day safety net at
 * 18:00 UTC — a Hobby plan rejects any expression that fires more than once a
 * day, which silently refuses every deployment — and it is never early: it is
 * exactly the deadline in winter and one hour after it in summer. The
 * local-hour gate inside `processStreakReminder()` decides which run is really
 * the deadline, and the per-day ledger guarantees at most one message no
 * matter how often it runs.
 *
 * Response contains counts only: never a lead, subject, body or URL.
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
    const outcome = await processStreakReminder();
    return NextResponse.json(
      {
        ok: true,
        ...outcome,
        processed_at: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Never echo the underlying message: it can contain Supabase/Telegram detail.
    console.error("streak reminder failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false, error: "reminder_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET. Refuse other verbs explicitly.
export async function POST(): Promise<NextResponse> {
  return unauthorized();
}
