/**
 * The label grammar of pasted outreach text — the single authority on which
 * words are field labels.
 *
 * Pepa V1 has ONE parser: `parseBulkEmails()` in `lib/import/bulk-emails.ts`,
 * which every paste goes through (single-lead bar and bulk dialog alike). It
 * imports this module's `recipientFromHeaderLine` so boundary detection and
 * field extraction share one label table. The former single-lead parser and
 * its separate grammar were removed in that migration; only the shared label
 * reader lives here.
 */

import { isValidEmail, normalizeEmail } from "./email";

type FieldKey = "recipient" | "subject" | "body";

type AliasEntry = { key: FieldKey; strong: boolean };

/**
 * Labels the parser recognises. `strong` labels always start a new field;
 * weak labels (the ambiguous ones like "To:") are only honoured while the
 * body is still empty, so a "To:" line inside a paragraph cannot split it.
 */
const ALIAS_MAP: Record<string, AliasEntry> = {
  recipient: { key: "recipient", strong: true },
  to: { key: "recipient", strong: false },
  email: { key: "recipient", strong: false },
  e: { key: "recipient", strong: false },
  mail: { key: "recipient", strong: false },
  "e-mail": { key: "recipient", strong: false },
  recipientka: { key: "recipient", strong: true },
  adresat: { key: "recipient", strong: true },
  prijemce: { key: "recipient", strong: true },
  komu: { key: "recipient", strong: false },
  subject: { key: "subject", strong: true },
  predmet: { key: "subject", strong: true },
  nadpis: { key: "subject", strong: true },
  title: { key: "subject", strong: false },
  body: { key: "body", strong: true },
  message: { key: "body", strong: true },
  text: { key: "body", strong: false },
  zprava: { key: "body", strong: true },
  obsah: { key: "body", strong: true },
  sdeleni: { key: "body", strong: true },
  "message-body": { key: "body", strong: true },
};

const LABEL_PATTERN =
  /^\s{0,4}(?:[-*>+]\s*)?(?:\*\*|__)?\s*([A-Za-z][A-Za-z0-9À-ž _-]{0,24}?)\s*(?:\*\*|__)?\s*[:：]\s*(.*)$/;

/**
 * Fold a label to its ASCII form so `Předmět` and `Predmet` are the same word.
 *
 * The alias table is written without diacritics, but operators type them — the
 * Czech labels are how most of this app's mail is written, and matching only the
 * ASCII spelling would quietly fail on a real paste. Folding is one-directional:
 * an unaccented label is unaffected.
 */
function foldLabel(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function matchLabel(
  line: string,
): { key: FieldKey; strong: boolean; value: string } | null {
  const match = LABEL_PATTERN.exec(line);
  if (!match) return null;
  const label = foldLabel(match[1])
    .toLowerCase()
    .replace(/[*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const alias = ALIAS_MAP[label];
  if (!alias) return null;
  return { key: alias.key, strong: alias.strong, value: match[2] ?? "" };
}

/**
 * The recipient a header line names, or null when the line is not one.
 *
 * Used by the bulk paste splitter to find where one email ends and the next
 * begins. A line only counts when it is a RECIPIENT label AND carries a valid
 * address, so `Subject:` and a `To:` mentioned mid-paragraph are not boundaries.
 *
 * Exported rather than reimplemented: the label table above is the single list
 * of words this parser treats as field names, and a splitter with its own copy
 * would drift from it.
 */
export function recipientFromHeaderLine(line: string): string | null {
  const label = matchLabel(line);
  if (!label || label.key !== "recipient") return null;
  const email = normalizeEmail(label.value);
  return isValidEmail(email) ? email : null;
}
