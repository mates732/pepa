/**
 * Bulk paste — splitting finished emails apart.
 *
 * The operator already HAS the emails. This module only takes a block of pasted
 * text and works out where one email stops and the next begins, then reads the
 * recipient / subject / body out of each piece. It is pure: no database, no
 * network, no AI, and — the point of the whole feature — it does not write,
 * rewrite, summarize, personalize or improve a single word.
 *
 * WHAT IS DELIBERATELY NOT HERE. No analysis, no offer selection, no
 * generation, no lead creation, no sending. The text that goes in is the text
 * that goes out, modulo the whitespace tidying at the bottom of this file.
 *
 * ## Splitting
 *
 * Recipient headers win. A line like `To: info@firma.cz` is a boundary because it
 * is an unambiguous statement about who the next email is for, so that is the
 * primary rule — and it is why a `---` inside a body does not split anything: a
 * horizontal rule carries no address, so it is only ever treated as a boundary
 * when there are no headers to go on.
 *
 * Four shapes are recognised, and the shapes are detected rather than declared
 * so the operator never has to pick:
 *
 *   A   To: info@firma.cz
 *       Subject: Váš web
 *       Dobrý den, ...
 *       ---
 *       To: barber@firma2.cz
 *       ...
 *
 *   B   Two or more emails separated only by a rule or a blank gap — no headers.
 *
 *   C   Copied mail-client blocks, which may carry `From:`/`Date:` chatter before
 *       the `To:` line, or quote previous replies with `>`.
 *   D   `--- LEAD NN ---` blocks — machine-generated batches (ChatGPT's
 *       structured output). Each block is one finished email plus an optional
 *       follow-up under `Follow-up Subject:` / `Follow-up Body:` labels.
 *
 * ## Identity
 *
 * The normalized address, via the same `normalizeEmail()` the database and the
 * composer use. `info@firma.cz` and `INFO@FIRMA.CZ` are one recipient, so they
 * become one draft and the second copy is reported as a duplicate rather than
 * quietly dropped.
 *
 * ## Tolerated, but never silently
 *
 * A block with no readable address is `needs_review` with a reason. It is never
 * turned into a half-built draft: the operator's own words must not end up
 * addressed to the wrong person.
 */

import { isValidEmail, normalizeEmail } from "../email.ts";
import { recipientFromHeaderLine } from "../parser.ts";

/**
 * Ceiling on one paste.
 *
 * The brief asks for at least 20. 100 is where a paste stops being a paste and
 * starts being a file someone should be reviewing as a document; anything beyond
 * it is counted and refused rather than silently truncated, so the operator is
 * told the difference between "all of it" and "some of it".
 */
export const MAX_BULK_EMAILS = 100;

/** Where a parsed email's identity came from, for the preview table. */
export type BulkEmailStatus = "parsed" | "duplicate" | "needs_review";

export interface BulkEmailCandidate {
  /** 1-based position in the paste. Stable across parse → preview → import. */
  index: number;
  /** Normalized (trimmed, unwrapped, lowercased) — the canonical identity. */
  recipient: string | null;
  /** Exactly as pasted, minus surrounding whitespace. */
  subject: string | null;
  /** Exactly as pasted, minus surrounding whitespace. */
  body: string | null;
  status: BulkEmailStatus;
  /** Why this is `duplicate` or `needs_review`. Null when it is usable. */
  reason: string | null;
  /** For `duplicate`: the `index` of the email this one repeats. */
  duplicateOf: number | null;
  /** Non-fatal notes from the field parser, e.g. an absent `Body:` label. */
  warnings: string[];
  /**
   * The block's follow-up, when it carries one — parsed as part of the
   * SAME lead. One lead is one card: the follow-up is never a second
   * candidate and never part of the primary body. A bulk paste imports
   * only the first outreach; the follow-up is reported so the operator
   * can draft it from the lead's detail page.
   */
  followUp: { subject: string | null; body: string | null } | null;
}

export interface BulkEmailParseResult {
  candidates: BulkEmailCandidate[];
  /** How the block was found to be divided. Informational, for the UI. */
  splitBy: "recipient_header" | "separator" | "blank_line" | "single";
  /** Blocks refused because the paste exceeded MAX_BULK_EMAILS. */
  truncated: number;
}

/* -------------------------------------------------------------------------- */
/* input tidying                                                               */
/* -------------------------------------------------------------------------- */

function toLines(text: string): string[] {
  return String(text ?? "")
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*```/.test(line));
}

/**
 * A horizontal rule: `---`, `___`, `===`, `***`, optionally spaced.
 *
 * Deliberately requires at least three repeated characters. A line of one or two
 * is far more likely to be a stray dash or a table rule than a deliberate
 * separator, and treating it as one would shred the body of an email that has
 * no headers.
 */
const RULE_LINE = /^\s*(?:[-_*=~#]\s*){3,}$/;

function isRule(line: string): boolean {
  return RULE_LINE.test(line);
}

/**
 * A `--- LEAD 01 ---` marker — the explicit block delimiter of a machine-
 * generated batch.
 *
 * A bare rule is only a boundary when something that looks like an email
 * follows it; a marker says "a new lead starts here" in so many words, so it
 * is always a boundary. The decoration is drawn from the same set as
 * `RULE_LINE`'s, so `*** LEAD 01 ***` reads the same as `--- LEAD 01 ---`.
 */
const LEAD_MARKER = /^\s*[-*_=~#]{2,}\s*LEAD\s+\d+\s*[-*_=~#]{2,}\s*$/i;

function isLeadMarker(line: string): boolean {
  return LEAD_MARKER.test(line);
}

/* -------------------------------------------------------------------------- */
/* block detection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Index of every line that opens a new email, and how those indices were found.
 *
 * Two passes, and the order is the whole design:
 *
 *  1. **Recipient headers and `--- LEAD NN ---` markers.** Any line whose
 *     label is a recipient word and whose value is a valid address, plus the
 *     explicit LEAD delimiter. These are the only lines that can be trusted on
 *     their own, because they are the only ones that say something about who
 *     the email is for. Two or more of them means the paste is unambiguous, so
 *     `---` inside a body is never consulted as a boundary.
 *  2. **Rules, then blank gaps.** Only when the block carries no usable headers
 *     to go on. Shape B has no addresses to find, and splitting on structure is
 *     the only signal left.
 *
 * Headers alone are not quite enough, though, and the gap matters. When a
 * pasted email has a rule DIRECTLY BEFORE the next `To:`, that rule is the
 * operator's separator, not part of the previous body — and a block with no
 * header of its own between the two is a separate email that is missing its
 * recipient, not trailing text belonging to the one before it. Without this,
 * dropping a recipient line would silently fold one business's malformed paste
 * into the previous business's body, and the operator would send that.
 */
/**
 * Does this line look like the OPENING of an email?
 *
 * The discriminator that lets `---` mean two different things. A rule inside a
 * letter is followed by prose; a rule the operator typed between two emails is
 * followed by another email's headers. Without this the feature has to pick one
 * and be wrong about the other: splitting on every rule chops real messages in
 * half, and never splitting merges one business's dropped `To:` line into the
 * previous business's body.
 */
function looksLikeEmailOpening(line: string): boolean {
  if (recipientFromHeaderLine(line)) return true;
  if (isLeadMarker(line)) return true;
  const label = labelOf(line);
  if (label && NOISE_LABELS.has(label.name)) return false;
  if (label && (SUBJECT_LABELS.has(label.name) || BODY_LABELS.has(label.name) || RECIPIENT_LABELS.has(label.name))) {
    return true;
  }
  // A bare address on its own line, as in the headerless format.
  return line.trim().length < 64 && isValidEmail(normalizeEmail(line));
}

function findBoundaries(lines: string[]): { starts: number[]; splitBy: BulkEmailParseResult["splitBy"] } {
  const headers: number[] = [];
  const markers: number[] = [];
  const rules: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (recipientFromHeaderLine(lines[i]!)) headers.push(i);
    else if (isLeadMarker(lines[i]!)) markers.push(i);
    else if (isRule(lines[i]!)) rules.push(i);
  }

  // A rule is a separator when what follows it opens an email — another set of
  // headers, or a bare address. A rule followed by ordinary prose is a divider
  // inside a letter and belongs to the body.
  const separatingRules = rules.filter((rule) => {
    let next = rule + 1;
    while (next < lines.length && lines[next]!.trim() === "") next += 1;
    return next < lines.length && looksLikeEmailOpening(lines[next]!);
  });

  // Shape A/C (recipient headers present) or shape D (LEAD markers
  // present). Headers are trusted absolutely, and a LEAD marker is an
  // explicit delimiter that opens a block on its own word — unlike a bare
  // rule, it needs nothing to follow it. Rules join only when an email
  // opening (a header or a marker) follows them; every other rule and
  // blank line stays body content.
  if (headers.length >= 1 || markers.length >= 1) {
    const starts = new Set<number>([...headers, ...markers, ...separatingRules]);
    // Material typed before the first header belongs to no email — "here are
    // the twenty emails:" and the like. Keeping it out of every block is what
    // stops it from being prepended to somebody's message body.
    return {
      starts: [...starts].sort((a, b) => a - b),
      splitBy:
        starts.size > 1
          ? headers.length >= 1
            ? "recipient_header"
            : "separator"
          : "single",
    };
  }

  if (rules.length >= 1) return { starts: rules, splitBy: "separator" };

  // No headers and no rules. Two or more blank lines are the last structural
  // hint; a single blank line inside a body is far more common than a separator.
  const blanks: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "" && lines[i - 1]!.trim() === "") blanks.push(i);
  }
  if (blanks.length >= 1) return { starts: blanks, splitBy: "blank_line" };

  return { starts: [0], splitBy: "single" };
}

/**
 * Cut the lines into blocks at the boundaries.
 *
 * Rule lines and LEAD markers are STRIPPED from the start of every block, and
 * trailing rules from its end. A rule or marker the paste used as a separator
 * belongs to neither email, and leaving it on the end of the previous body would
 * put `---` at the foot of a real message. A rule in the MIDDLE of a block is
 * body text and is left exactly where it is — that is the case where a `---`
 * genuinely separates paragraphs in a letter.
 */
function toBlocks(
  lines: string[],
  boundaries: { starts: number[]; splitBy: BulkEmailParseResult["splitBy"] },
): string[][] {
  const { starts, splitBy } = boundaries;

  const blocks: string[][] = [];

  // In separator and blank-line mode the boundary is BETWEEN two emails, so what
  // precedes it is the first email and must become a block of its own. In header
  // mode — including a single email — the boundary is that email's own opening
  // line, so the lines before it belong to the SAME block: they are the
  // `From:` / `Date:` a mail client copies along, and `extract()` knows to drop
  // them. Detaching them would turn one copied email into an unreadable block
  // plus a real one.
  const boundaryIsBetweenEmails = splitBy === "separator" || splitBy === "blank_line";
  if (boundaryIsBetweenEmails && starts[0]! > 0) {
    blocks.push(lines.slice(0, starts[0]!));
  }

  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : lines.length;
    const slice = lines.slice(from, to);

    // The boundary itself is the first line of the block; strip the
    // delimiter (a separator rule or a LEAD marker counted as a boundary).
    while (slice.length > 0 && (isRule(slice[0]!) || isLeadMarker(slice[0]!))) slice.shift();
    blocks.push(trimTrailingRuleChatter(slice));
  }

  return blocks.filter((block) => block.some((line) => line.trim() !== ""));
}

/**
 * Cut a block back to its last real content.
 *
 * A pasted mail block reads:
 *
 *     ...the previous email's body...
 *     ---
 *     From: Petr <petr@firma.cz>
 *     Date: Tue, 1 Oct 2026 ...
 *     To: the next recipient
 *
 * The `From:` and `Date:` belong to the NEXT email — they are the header the
 * operator's mail client copied above its `To:` — but they fall inside this
 * block, and appending them would put a stranger's address at the foot of
 * somebody else's message.
 *
 * Only cut when the tail is exactly that shape: a rule, then nothing but blank
 * and mail-header lines. A body that merely mentions `From:` is untouched,
 * because the rule it would have to end with is not there.
 */
function trimTrailingRuleChatter(block: string[]): string[] {
  let end = block.length;
  while (end > 0 && (isRule(block[end - 1]!) || block[end - 1]!.trim() === "")) end -= 1;

  const lastRule = block.findLastIndex(isRule);
  if (lastRule === -1) return block;

  // Everything after the last rule is rule chatter or mail headers?
  const chatter = block.slice(lastRule + 1);
  const allChatter = chatter.every(
    (line) =>
      line.trim() === "" ||
      (() => {
        const label = labelOf(line);
        return Boolean(label && NOISE_LABELS.has(label.name));
      })(),
  );
  if (!allChatter || chatter.length === 0) return block;

  return block.slice(0, lastRule);
}

/* -------------------------------------------------------------------------- */
/* field extraction                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `To:`, `Subject:`, `Body:`, and the aliases `parseOutreachInput` already knows.
 *
 * This is a small reader rather than a second parser: the single-email parser is
 * the authority on which words are field labels, and `recipientFromHeaderLine`
 * above is its own logic reused so both sides agree. The inline value after a
 * label is only taken when it is on the SAME line — `To:` followed by the
 * address on the next line is handled by the fallback below, because a subject
 * body must never be swallowed as a recipient.
 */
const INLINE_LABEL = /^\s{0,4}(?:[-*>+]\s*)?(?:\*\*|__)?\s*([A-Za-z][A-Za-z0-9À-ž _-]{0,24}?)\s*(?:\*\*|__)?\s*[:：]\s*(.*)$/;

const RECIPIENT_LABELS = new Set([
  "to", "recipient", "recipientka", "adresat", "prijemce", "komu", "e", "email", "mail", "e-mail",
]);

const SUBJECT_LABELS = new Set(["subject", "predmet", "nadpis", "title"]);

const BODY_LABELS = new Set([
  "body", "message", "message-body", "text", "zprava", "obsah", "sdeleni",
]);

/**
 * Headers a mail client copies along that are not part of the message.
 *
 * Dropped from the top of a block so they cannot be mistaken for the body —
 * `From:` in particular, because a quoted thread puts the ORIGINAL sender's
 * address there and that is emphatically not who this email is for.
 */
const NOISE_LABELS = new Set(["from", "od", "date", "datum", "sent", "cc", "bcc", "reply-to"]);

/**
 * The follow-up half of a `--- LEAD NN ---` block.
 *
 * A batch export writes each lead's follow-up under its own labels, after the
 * first email's body. Recognising them as labels — instead of letting them
 * read as body text — is what keeps the follow-up out of the first email's
 * draft, where it would be sent to the wrong person at the wrong time.
 */
const FOLLOWUP_SUBJECT_LABELS = new Set(["follow-up subject", "followup subject"]);
const FOLLOWUP_BODY_LABELS = new Set(["follow-up body", "followup body"]);

interface Extracted {
  recipient: string | null;
  recipientRaw: string | null;
  subject: string | null;
  body: string;
  warnings: string[];
  /** The address on a bare `Name <addr>` line, used when there is no label. */
  bareAddress: string | null;
  /** The block's follow-up section, when it carries one. */
  followUp: { subject: string | null; body: string } | null;
}

function labelOf(line: string): { name: string; value: string } | null {
  const match = INLINE_LABEL.exec(line);
  if (!match) return null;
  const name = match[1]!
    // Same folding the single-email parser applies, so `Předmět` is `predmet`
    // here too. One rule for accents, in the parser that owns it.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { name, value: match[2] ?? "" };
}

/**
 * Read one block's fields.
 *
 * The order the walk uses is the order a mail client writes them: recipient,
 * subject, body. Anything before the first recognised label is preamble — for a
 * copied block that is the `From:`/`Date:` chatter, which is dropped, and for a
 * hand-written block it is the greeting, which becomes the body so the operator's
 * opening line is never lost.
 */
function extract(block: string[]): Extracted {
  const preamble: string[] = [];
  const bodyLines: string[] = [];
  const warnings: string[] = [];

  let recipientRaw: string | null = null;
  let subject: string | null = null;
  let bareAddress: string | null = null;
  let current: "recipient" | "subject" | "body" | null = null;
  let inFollowUp = false;
  let followUpSubject: string | null = null;
  const followUpBody: string[] = [];

  for (const line of block) {
    const label = labelOf(line);
    const inlineEmail = label ? normalizeEmail(label.value) : "";

    if (label && RECIPIENT_LABELS.has(label.name)) {
      current = "recipient";
      if (!label.value.trim()) continue;
      recipientRaw = label.value.trim();
      if (isValidEmail(inlineEmail)) continue;
      warnings.push(`Could not read an email address from "${label.value.trim()}".`);
      continue;
    }

    if (label && SUBJECT_LABELS.has(label.name)) {
      current = "subject";
      if (label.value.trim()) subject = label.value.trim();
      continue;
    }

    if (label && BODY_LABELS.has(label.name)) {
      current = "body";
      if (label.value.trim()) bodyLines.push(label.value);
      continue;
    }

    if (label && FOLLOWUP_SUBJECT_LABELS.has(label.name)) {
      inFollowUp = true;
      if (label.value.trim()) followUpSubject = label.value.trim();
      continue;
    }

    if (label && FOLLOWUP_BODY_LABELS.has(label.name)) {
      inFollowUp = true;
      if (label.value.trim()) followUpBody.push(label.value);
      continue;
    }

    // Once the follow-up section opens, the rest of the block is the
    // follow-up's own text — including any further unrecognised labels.
    if (inFollowUp) {
      if (label && NOISE_LABELS.has(label.name)) continue;
      followUpBody.push(line);
      continue;
    }

    if (label && NOISE_LABELS.has(label.name)) continue;

    if (current === "recipient") {
      // The address wrapped onto the line below `To:`. Take it if it is one,
      // otherwise this was a stray colon and the line belongs to the body.
      const candidate = normalizeEmail(line);
      if (isValidEmail(candidate)) {
        recipientRaw = line.trim();
        current = null;
        continue;
      }
      current = null;
    }

    if (current === "subject") {
      // A subject is a single line; a continuation means the block had no
      // subject label at all and this is really the greeting.
      if (line.trim() && isValidEmail(normalizeEmail(line))) {
        bareAddress ??= line.trim();
        current = null;
        continue;
      }
      current = null;
    }

    if (!current) {
      const bare = normalizeEmail(line);
      // A block with no `To:` label but an address on its own line: take the
      // address as the recipient and drop the line, so the recipient does not
      // end up as the first line of the message body. Everything after it is
      // kept verbatim — guessing which line is a subject and which is a greeting
      // would be inventing structure the operator did not write.
      if (!bareAddress && isValidEmail(bare) && line.trim().length < 64) {
        bareAddress = line.trim();
        continue;
      }
      preamble.push(line);
      continue;
    }

    bodyLines.push(line);
  }

  const body = (bodyLines.length > 0 ? bodyLines : preamble).join("\n");
  const normalized = normalizeEmail(recipientRaw ?? "");
  // Validity, not emptiness. `To: info@ bella .cz` normalizes to a non-empty
  // string that is still not an address, and letting that through would produce
  // a draft addressed to nonsense.
  const recipient = isValidEmail(normalized) ? normalized : null;

  if (!recipient && recipientRaw) {
    warnings.push(`Could not read an email address from "${recipientRaw}".`);
  }

  return {
    recipient,
    recipientRaw,
    subject,
    body,
    warnings,
    bareAddress,
    followUp: inFollowUp ? { subject: followUpSubject, body: followUpBody.join("\n") } : null,
  };
}

/**
 * Whitespace tidying, and the ONLY modification made to the operator's text.
 *
 * Line endings are normalised, trailing spaces are dropped, and blank runs are
 * collapsed. No word is added, removed, reordered or reworded. Everything
 * `createDraft` would do to the same text — trimming the outside, capping the
 * length — still applies afterwards, because it applies to every draft in the
 * app and is not this feature's business to change.
 */
function tidy(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip one level of `>` quoting so the body is the reply, not the history. */
function unquote(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}>\s?/, ""))
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* parse                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Split a paste into individual emails and read each one's fields.
 *
 * Rows repeating a recipient are folded with `duplicate` rather than dropped, so
 * the preview can show the operator exactly what happened to their input instead
 * of quietly returning fewer emails than they pasted. A `--- LEAD NN ---` block
 * that carries a follow-up yields ONE candidate: the first outreach — the one a
 * bulk import creates — with the follow-up carried on it as a field, because one
 * lead is one card and the follow-up is not part of the first email's text.
 */
export function parseBulkEmails(text: string): BulkEmailParseResult {
  const lines = toLines(text);
  const boundaries = findBoundaries(lines);
  const blocks = toBlocks(lines, boundaries);

  const candidates: BulkEmailCandidate[] = [];
  const seen = new Map<string, number>();
  let truncated = 0;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!;
    const found = extract(block);

    // A labelled `To:` is authoritative. A bare address is accepted only when
    // the block named no recipient at all, and only when it reads like an
    // address rather than a sentence containing one.
    const recipient =
      found.recipient ??
      (found.recipientRaw === null && found.bareAddress && isValidEmail(found.bareAddress)
        ? normalizeEmail(found.bareAddress)
        : null);

    const subject = found.subject ? tidy(found.subject) : null;
    const body = unquote(tidy(found.body));
    const warnings = [...found.warnings];

    let status: BulkEmailStatus = "parsed";
    let reason: string | null = null;
    let duplicateOf: number | null = null;

    if (!recipient) {
      status = "needs_review";
      reason =
        "No recipient address found in this block. Expected a line such as `To: info@company.cz`.";
    } else if (subject === null) {
      warnings.push("No subject found — the draft will have an empty subject.");
    } else if (body === "") {
      warnings.push("No body text found in this block.");
    }

    const index = i + 1;

    if (recipient && status === "parsed") {
      const first = seen.get(recipient);
      if (first !== undefined) {
        status = "duplicate";
        duplicateOf = first;
        reason = `Same recipient as email ${first} — imported once.`;
      } else {
        seen.set(recipient, index);
      }
    }

    // The follow-up belongs to this lead, not to a card of its own. Tidied
    // like any other field, and empty when the block carries no follow-up.
    const followUp =
      found.followUp && (found.followUp.subject !== null || found.followUp.body.trim() !== "")
        ? {
            subject: found.followUp.subject ? tidy(found.followUp.subject) : null,
            body: found.followUp.body.trim() === "" ? null : unquote(tidy(found.followUp.body)),
          }
        : null;
    if (followUp) {
      warnings.push(
        "A follow-up was also found in this block — it is carried on this card as the follow-up field, and it is not part of this draft.",
      );
    }

    if (candidates.length < MAX_BULK_EMAILS) {
      candidates.push({
        index,
        recipient,
        subject,
        body: body === "" ? null : body,
        status,
        reason,
        duplicateOf,
        warnings,
        followUp,
      });
    } else {
      truncated += 1;
    }
  }

  return { candidates, splitBy: boundaries.splitBy, truncated };
}