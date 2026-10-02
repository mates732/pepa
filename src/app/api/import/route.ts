import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { constantTimeEquals } from "@/lib/auth/token";
import { MAX_IMPORT_PAYLOAD_BYTES, type OutreachImportInput } from "@/lib/import/outreach-import";
import { createOutreachImport } from "@/lib/services/import-service";

/**
 * Outbound import endpoint — the hand-off point for ChatGPT.
 *
 * PEPA holds no AI credential and calls no model. Whatever produces the email
 * (a ChatGPT action, a script, the operator's own curl) authenticates with
 * `IMPORT_SECRET`, which is a server-only bearer secret compared in constant
 * time. The endpoint fails closed when the secret is unset; there is no
 * development bypass.
 *
 * In:  a JSON payload of recipient / subject / body (+ optional names).
 * Out: a short-lived opaque link — never the token, never a database id, never
 *      an echo of the stored payload.
 *
 * Nothing here sends email. The payload becomes an ordinary draft that the
 * operator reviews and edits in the composer.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Distinct status codes so a legitimate client can tell a conflict from a bug. */
const STATUS_BY_REASON = {
  invalid_payload: 400,
  already_contacted: 409,
  store_failed: 500,
} as const;

export function isAuthorizedImportRequest(request: NextRequest): boolean {
  const secret = process.env.IMPORT_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  return constantTimeEquals(match[1].trim(), secret);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedImportRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Hard cap before parsing: a payload this large is not an outreach draft.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_IMPORT_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Payload could not be read." }, { status: 400 });
  }

  if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_PAYLOAD_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  let parsed: OutreachImportInput;
  try {
    parsed = JSON.parse(raw) as OutreachImportInput;
  } catch {
    return NextResponse.json({ error: "Payload must be valid JSON." }, { status: 400 });
  }

  const outcome = await createOutreachImport(parsed);

  if (!outcome.ok) {
    const status = STATUS_BY_REASON[outcome.reason] ?? 400;
    // The error text describes the payload problem only. No token, no lead id,
    // no stored content is echoed back.
    return NextResponse.json({ ok: false, error: outcome.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    deep_link: outcome.deepLink,
    recipient: outcome.recipient,
    // The producer learns the outcome without learning anything about storage.
    status: outcome.alreadyContacted ? "already_contacted" : outcome.created ? "created" : "refreshed",
    expires_at: outcome.expiresAt,
  });
}

/** Explicitly refuse other verbs. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}