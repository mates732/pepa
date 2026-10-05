import { isValidEmail, normalizeEmail } from "./email";
import type { ParsedOutreachInput } from "./types";

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

function matchLabel(line: string): { key: FieldKey; strong: boolean; value: string } | null {
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

function stripCodeFences(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n");
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length > 1 && (first === last) && ['"', "'", "`"].includes(first)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function cleanBody(value: string): string {
  const unquoted = value
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}>\s?/, ""))
    .join("\n");
  const lines = unquoted.replace(/[ \t]+$/gm, "").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
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

/**
 * Parse pasted outreach text into recipient / subject / body.
 *
 * Tolerates: any label casing, `Label:` or `Label :`, markdown bold labels,
 * bullet prefixes, colons in full-width form, `Name <mail>` recipients,
 * quoted single-line values, and multiline bodies that continue until the
 * next label.
 */
export function parseOutreachInput(raw: string): ParsedOutreachInput {
  const warnings: string[] = [];
  const text = stripCodeFences(String(raw ?? "").replace(/\r\n?/g, "\n"));
  const lines = text.split("\n");

  const buffer: Record<FieldKey, string[]> = { recipient: [], subject: [], body: [] };
  const preamble: string[] = [];
  /** Lines that overflow a single-line field (recipient / subject). */
  const overflow: string[] = [];
  const seen = new Set<FieldKey>();
  let current: FieldKey | null = null;

  for (const line of lines) {
    const label = matchLabel(line);
    const bodySeen = seen.has("body");
    const acceptable = label && (label.strong || !bodySeen);

    if (acceptable && label) {
      current = label.key;
      seen.add(current);
      const inline = label.value.trim();
      if (inline) buffer[current].push(inline);
      continue;
    }

    if (!current) {
      preamble.push(line);
    } else if (current === "body" || buffer[current].length === 0) {
      buffer[current].push(line);
    } else {
      // `recipient:` and `subject:` are single-line fields; anything that
      // follows belongs to whatever comes next.
      overflow.push(line);
    }
  }

  const recipientRaw = stripWrappingQuotes(buffer.recipient.join(" ").trim());
  const recipient = normalizeEmail(recipientRaw);
  let subject = stripWrappingQuotes(buffer.subject.join(" ").trim());

  let body = cleanBody(buffer.body.join("\n"));
  const overflowText = cleanBody(overflow.join("\n"));

  if (!body && overflowText) {
    if (seen.has("body")) {
      // A wrapped `subject:` line sitting above the body label.
      subject = stripWrappingQuotes(`${subject} ${overflowText}`.trim());
    } else {
      warnings.push("No 'body:' label found — the remaining text was used as the body.");
      body = overflowText;
    }
  }

  if (!body) {
    const fallback = cleanBody(preamble.join("\n"));
    if (fallback) {
      warnings.push(
        seen.size > 0
          ? "No 'body:' label found — the text before the labels was used as the body."
          : "No 'recipient:', 'subject:' or 'body:' labels found.",
      );
      body = fallback;
    }
  }

  const missing: ParsedOutreachInput["missing"] = [];
  if (!recipient) missing.push("recipient");
  if (!subject) missing.push("subject");
  if (!body) missing.push("body");

  if (recipientRaw && !recipient) {
    warnings.push(`Could not read an email address from "${recipientRaw}".`);
  }

  return { recipient, subject, body, missing, warnings };
}