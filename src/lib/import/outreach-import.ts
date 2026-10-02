/**
 * Outbound-import payload validation.
 *
 * ChatGPT is an untrusted producer. Whatever it emits — well-formed JSON or a
 * hand-edited curl body — is treated as hostile input until it has passed every
 * rule in this file. Nothing here trusts a value the caller claims to have
 * already normalised: `normalizeEmail` is applied here, server-side, using the
 * same rules as `public.normalize_email` and the rest of PEPA.
 *
 * Pure module: no I/O, no database, no environment access. The import route and
 * the import flow both run the same validator, so a payload that was accepted
 * at the door is still accepted when it is read back — and a stored payload that
 * has been tampered with is rejected at that later point too.
 */

import { isValidEmail, normalizeEmail } from "@/lib/email";

/** Matches the `subject` column width in the initial migration. */
export const MAX_IMPORT_SUBJECT = 998;

/**
 * A generated cold email is a few hundred characters. 20k leaves generous room
 * for a long value proposition while keeping the stored draft reviewable. The
 * limit is enforced by *rejecting*, never by silent truncation: a truncated
 * email is a broken email.
 */
export const MAX_IMPORT_BODY = 20_000;

/** Optional lead context. Both are optional, both are length-capped. */
export const MAX_IMPORT_NAME = 200;

/** Anything past this is not an outreach draft, it is an attack. */
export const MAX_IMPORT_PAYLOAD_BYTES = 64 * 1024;

export interface OutreachImportInput {
  recipient?: unknown;
  subject?: unknown;
  body?: unknown;
  companyName?: unknown;
  contactName?: unknown;
}

export interface OutreachImportPayload {
  /** Always the normalized form — the only spelling written to the database. */
  recipient: string;
  subject: string;
  body: string;
  companyName: string | null;
  contactName: string | null;
}

export type ImportValidation =
  | { ok: true; payload: OutreachImportPayload }
  | { ok: false; error: string };

/** Printable control characters are stripped; newlines and tabs are kept. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * CRLF and lone CR collapse to LF.
 *
 * An imported body may arrive from a Windows editor or a copy-paste; leaving
 * `\r` in would show up as stray characters in the composer and in the stored
 * draft. This is a lossless normalisation of line endings, not a content edit.
 */
const LINE_ENDINGS = /\r\n?/g;

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, "").replace(LINE_ENDINGS, "\n").trim();
}

/**
 * Validate and normalize an inbound import.
 *
 * Rejects rather than repairs: an empty subject or a 40k body is a signal that
 * something is wrong with the producer, and silently fixing it would hide that.
 */
export function validateOutreachImport(input: OutreachImportInput): ImportValidation {
  if (input === null || typeof input !== "object") {
    return { ok: false, error: "Import payload must be a JSON object." };
  }

  // Normalization happens here, never in the caller: the database's unique index
  // is the dedupe guarantee, so only the canonical spelling may be stored.
  const recipient = normalizeEmail(
    typeof input.recipient === "string" ? input.recipient : "",
  );

  if (!recipient) {
    return { ok: false, error: "A recipient email is required." };
  }
  if (!isValidEmail(recipient)) {
    return { ok: false, error: `"${recipient}" is not a valid email address.` };
  }

  const subject = cleanText(input.subject);
  if (!subject) {
    return { ok: false, error: "A subject is required." };
  }
  if (subject.length > MAX_IMPORT_SUBJECT) {
    return {
      ok: false,
      error: `Subject is too long (${subject.length} characters, maximum ${MAX_IMPORT_SUBJECT}).`,
    };
  }

  // The body keeps its internal line breaks; only control characters go.
  const body =
    typeof input.body === "string"
      ? input.body.replace(CONTROL_CHARS, "").replace(LINE_ENDINGS, "\n").trim()
      : "";
  if (!body) {
    return { ok: false, error: "A body is required." };
  }
  if (body.length > MAX_IMPORT_BODY) {
    return {
      ok: false,
      error: `Body is too long (${body.length} characters, maximum ${MAX_IMPORT_BODY}).`,
    };
  }

  const companyName = cleanText(input.companyName).slice(0, MAX_IMPORT_NAME) || null;
  const contactName = cleanText(input.contactName).slice(0, MAX_IMPORT_NAME) || null;

  return {
    ok: true,
    payload: { recipient, subject, body, companyName, contactName },
  };
}

/** Byte size of the serialized payload, for the route's hard request cap. */
export function importPayloadBytes(input: OutreachImportInput): number {
  return Buffer.byteLength(JSON.stringify(input ?? {}), "utf8");
}