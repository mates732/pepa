/**
 * Legacy outreach export — parsing and validation.
 *
 * `pepa_outreach_history_detailed.csv` is an AGGREGATE per address: email,
 * company, domain, contact_count, first_contact, last_contact and a
 * de-duplicated list of subject lines joined with `||`. It is not a message
 * log, and this module never pretends otherwise — see
 * `supabase/migrations/20260101000600_historical_outreach.sql` for why no
 * `outreach_messages` rows are fabricated from it.
 *
 * Pure module: no I/O, no database, no environment access. The importer script
 * and the tests run exactly the same rules, so a row the parser accepted is the
 * row that reaches the database.
 *
 * Imports here are RELATIVE and carry explicit `.ts` extensions, and that is
 * deliberate: `npm run import:historical-outreach` executes
 * `scripts/import-historical-outreach.ts` with plain `node`, which resolves
 * neither the tsconfig path alias nor an extensionless specifier. Keep this
 * module and everything it imports alias-free.
 */

import { isValidEmail, normalizeEmail } from "../email.ts";
import { domainFromEmail, normalizeDomain } from "../outreach/domain.ts";

/** The seven columns the export is expected to carry, in order. */
const HEADER = [
  "email",
  "company",
  "domain",
  "contact_count",
  "first_contact",
  "last_contact",
  "subjects",
] as const;

/** Separator the export used to join de-duplicated subject lines. */
export const SUBJECT_SEPARATOR = " || ";

/** Anything past this is not a contact record, it is a mistake or an attack. */
export const MAX_HISTORICAL_SUBJECTS = 20_000;
export const MAX_HISTORICAL_COMPANY = 200;

/**
 * One imported contact, normalized and ready to insert.
 *
 * `normalizedEmail` is the canonical identity and is what the unique constraint
 * in the migration is built on. `domain` is the secondary identity and is stored
 * in canonical form so a company-level lookup cannot be dodged by spelling it
 * `WWW.Example.cz`.
 */
export interface HistoricalOutreachContact {
  email: string;
  normalizedEmail: string;
  company: string | null;
  domain: string;
  contactCount: number;
  firstContactAt: string;
  lastContactAt: string;
  subjects: string | null;
}

/** A row that was refused, with the reason. Never silently dropped. */
export interface HistoricalOutreachRejection {
  /** 1-based line in the source file, counting the header. */
  line: number;
  email: string;
  reason: string;
}

export interface HistoricalOutreachParse {
  contacts: HistoricalOutreachContact[];
  rejections: HistoricalOutreachRejection[];
  /** Rows folded into an earlier row because the address repeated in the file. */
  duplicatesMerged: number;
}

/** The exact shape written to `historical_outreach`. */
export interface HistoricalOutreachInsertRow {
  email: string;
  company: string | null;
  domain: string;
  contact_count: number;
  first_contact_at: string;
  last_contact_at: string;
  subjects: string | null;
  source: "historical_import";
}

/* -------------------------------------------------------------------------- */
/* CSV reader                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split one RFC 4180 record.
 *
 * The export quotes any field containing a comma, and Czech subject lines
 * contain commas constantly, so a naive `split(",")` corrupts 46 rows. Handles
 * doubled quotes (`""` inside a quoted field) and CRLF.
 */
function splitRecord(record: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < record.length; i += 1) {
    const char = record[i];

    if (quoted) {
      if (char === '"') {
        if (record[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      fields.push(field);
      field = "";
      continue;
    }
    field += char;
  }

  fields.push(field);
  return fields;
}

/**
 * Normalize a file into records, dropping a UTF-8 BOM and blank lines.
 *
 * The BOM matters: it is present in this export and would otherwise become part
 * of the first header cell, so the column map would be off by one for every
 * row.
 */
function toRecords(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/* -------------------------------------------------------------------------- */
/* field validation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * An ISO instant in UTC, or null when the value is not a usable timestamp.
 *
 * The export uses `+00:00` offsets; everything stored is converted to `Z` so a
 * comparison against a Pep-generated `sent_at` is a plain instant comparison
 * rather than a re-parse on the reader's side.
 */
function toUtcInstant(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Clean free text: drop control characters, collapse whitespace, cap length. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanText(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const cleaned = value.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

/** The export's subject list, kept as one string. De-duplicated already. */
function cleanSubjects(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_HISTORICAL_SUBJECTS) return null;
  return cleaned;
}

/* -------------------------------------------------------------------------- */
/* parsing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse the legacy export into normalized, insertable contacts.
 *
 * Rejects rather than repairs. A row with an unusable address or an unreadable
 * date is reported with its line number and reason, because a silently skipped
 * contact is a contact Pepa would then be free to email a second time — the one
 * failure this whole exercise exists to prevent. Every rejection is therefore
 * surfaced, and the importer refuses to run to completion over any of them
 * unless explicitly told to.
 */
export function parseHistoricalOutreachCsv(text: string): HistoricalOutreachParse {
  const records = toRecords(text);
  const contacts: HistoricalOutreachContact[] = [];
  const rejections: HistoricalOutreachRejection[] = [];
  let duplicatesMerged = 0;

  if (records.length === 0) {
    return {
      contacts,
      rejections: [{ line: 0, email: "", reason: "The export is empty." }],
      duplicatesMerged,
    };
  }

  // Column order is read from the header rather than assumed, so a reordered
  // export cannot write a date into contact_count.
  const header = splitRecord(records[0]).map((cell) => cell.trim().toLowerCase());
  const missing = HEADER.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return {
      contacts,
      rejections: [
        {
          line: 1,
          email: "",
          reason: `Header is missing column(s): ${missing.join(", ")}. Expected: ${HEADER.join(", ")}.`,
        },
      ],
      duplicatesMerged,
    };
  }

  const index = Object.fromEntries(HEADER.map((column) => [column, header.indexOf(column)])) as Record<
    (typeof HEADER)[number],
    number
  >;

  for (let i = 1; i < records.length; i += 1) {
    const line = i + 1;
    const cells = splitRecord(records[i]);
    const cell = (column: (typeof HEADER)[number]) => cells[index[column]] ?? "";

    const rawEmail = cell("email").trim();
    const reject = (reason: string) =>
      rejections.push({ line, email: rawEmail, reason });

    const normalizedEmail = normalizeEmail(rawEmail);
    if (!normalizedEmail) {
      reject("The email cell is empty.");
      continue;
    }
    if (!isValidEmail(normalizedEmail)) {
      reject(`"${rawEmail}" is not a valid email address.`);
      continue;
    }

    // The export's own domain column is kept when it is a real hostname, and
    // derived from the address when it is absent. A supplied-but-unusable value
    // falls back to the address rather than being stored as a phantom identity.
    const suppliedDomain = normalizeDomain(cell("domain"));
    const domain = suppliedDomain || domainFromEmail(normalizedEmail);
    if (!domain) {
      reject(`"${rawEmail}" has no usable domain.`);
      continue;
    }

    const contactCountRaw = cell("contact_count").trim();
    const contactCount = contactCountRaw === "" ? 1 : Number.parseInt(contactCountRaw, 10);
    if (!Number.isInteger(contactCount) || contactCount < 1) {
      reject(`contact_count "${contactCountRaw}" is not a whole number of at least 1.`);
      continue;
    }

    const firstContactAt = toUtcInstant(cell("first_contact"));
    if (!firstContactAt) {
      reject(`first_contact "${cell("first_contact").trim()}" is not a valid date.`);
      continue;
    }

    const lastContactAt = toUtcInstant(cell("last_contact"));
    if (!lastContactAt) {
      reject(`last_contact "${cell("last_contact").trim()}" is not a valid date.`);
      continue;
    }

    if (Date.parse(lastContactAt) < Date.parse(firstContactAt)) {
      reject("last_contact is earlier than first_contact.");
      continue;
    }

    const subjects = cleanSubjects(cell("subjects"));

    const contact: HistoricalOutreachContact = {
      // The canonical spelling is what is stored, so the stored text and the
      // identity column can never disagree about the address.
      email: normalizedEmail,
      normalizedEmail,
      company: cleanText(cell("company"), MAX_HISTORICAL_COMPANY),
      domain,
      contactCount,
      firstContactAt,
      lastContactAt,
      subjects,
    };

    // Two rows for one address in the same file are merged rather than one
    // winning arbitrarily: the earliest first contact, the latest last contact,
    // the larger count, and the union of the subject lists. Nothing is dropped.
    const existing = contacts.find((row) => row.normalizedEmail === normalizedEmail);
    if (!existing) {
      contacts.push(contact);
      continue;
    }

    duplicatesMerged += 1;
    existing.firstContactAt =
      Date.parse(contact.firstContactAt) < Date.parse(existing.firstContactAt)
        ? contact.firstContactAt
        : existing.firstContactAt;
    existing.lastContactAt =
      Date.parse(contact.lastContactAt) > Date.parse(existing.lastContactAt)
        ? contact.lastContactAt
        : existing.lastContactAt;
    existing.contactCount = Math.max(existing.contactCount, contact.contactCount);
    if (contact.subjects && contact.subjects !== existing.subjects) {
      existing.subjects = `${existing.subjects ?? ""}${SUBJECT_SEPARATOR}${contact.subjects}`;
    }
    if (!existing.company && contact.company) existing.company = contact.company;
  }

  return { contacts, rejections, duplicatesMerged };
}

/**
 * Map a parsed contact to the row written to `historical_outreach`.
 *
 * `source` is pinned here rather than at the call site, so every write through
 * this module is labelled and the migration's CHECK holds by construction.
 */
export function toHistoricalOutreachRow(
  contact: HistoricalOutreachContact,
): HistoricalOutreachInsertRow {
  return {
    email: contact.email,
    company: contact.company,
    domain: contact.domain,
    contact_count: contact.contactCount,
    first_contact_at: contact.firstContactAt,
    last_contact_at: contact.lastContactAt,
    subjects: contact.subjects,
    source: "historical_import",
  };
}