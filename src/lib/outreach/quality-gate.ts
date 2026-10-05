/**
 * Outreach quality gate — pure rules.
 *
 * PEPA is the quality gate between AI-generated outreach and a human who will
 * actually send it. AI may generate creatively; this module is deliberately
 * paranoid and completely deterministic. No model, no network, no database, no
 * clock of its own: every decision is a pure function of the draft plus the
 * history context handed to it, so the same input always yields the same
 * verdict and every verdict can be unit-tested.
 *
 * Design rules that shaped this file:
 *
 *   * Explicit checks, never a mystery score. A 0–100 "AI quality" number
 *     implies a precision this cannot deliver and would be acted on as if it
 *     were meaningful. The caller gets named checks with reasons instead.
 *   * Similarity is measured on normalised text, never on raw strings, so
 *     casing, punctuation and diacritics cannot hide a copy/paste repeat.
 *   * The draft being evaluated is never compared against itself. The caller
 *     excludes it from history; see `excludeMessageIds`.
 *   * Nothing here decides what is *true* about a prospect. There is no
 *     evidence store in PEPA yet, so a claim with nothing behind it is
 *     reported as unsupported, never as false.
 *
 * The database-facing half lives in `src/lib/services/outreach-quality-gate.ts`.
 */

import { ALREADY_CONTACTED, ALREADY_CONTACTED_DOMAIN, type HistoricalContact } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* results                                                                    */
/* -------------------------------------------------------------------------- */

export type GateStatus = "ready" | "warning" | "blocked";

/**
 * Per-check outcome.
 *
 * `pass` carries no reason worth rendering. `warn` and `block` always carry
 * one, because the operator has to be able to answer "why is this not ready?"
 * without opening a log.
 */
export type CheckStatus = "pass" | "warn" | "block";

export interface QualityCheck {
  /** Stable machine name; the UI maps this to a label. */
  name: string;
  status: CheckStatus;
  /**
   * Stable machine reason, present only where an operator or another system has
   * to act on the verdict rather than merely read it. `ALREADY_CONTACTED` is
   * the one the send path is expected to branch on.
   */
  code?: string;
  /** Human-readable explanation. Never contains a secret. */
  reason: string;
  /**
   * Short supporting facts safe to render next to the reason: a date, a count,
   * a similarity percentage, an index into the compared history. Never email
   * bodies, never tokens, never credentials.
   */
  evidence?: string[];
}

export interface QualityGateResult {
  status: GateStatus;
  checks: QualityCheck[];
  /** Blocking reasons, most important first. Empty when not blocked. */
  reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* inputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A previous outreach message, reduced to what the gate compares.
 *
 * `index` is the message's position in the caller's history array (0 = newest)
 * and is echoed into evidence so the operator can tell *which* earlier email a
 * warning refers to without the UI having to display historical bodies.
 */
export interface HistoryMessage {
  id: string;
  subject: string | null;
  body: string | null;
  status: string;
  sentAt: string | null;
  createdAt: string;
  /** 0 = newest. Filled in by the service from the query order. */
  index?: number;
}

export interface GateInput {
  recipient: string;
  subject: string;
  body: string;
  /** Set when re-checking the same draft that is already stored. */
  messageId?: string | null;
  /**
   * Position in the lead's outreach sequence, read back from Postgres.
   *
   * 0 (or unknown) means NEW COLD OUTREACH. Anything above 0 is a follow-up
   * inside a sequence Pepa is already running, which is a different act from
   * pitching a company for the first time — and is deliberately not subject to
   * the permanent historical-contact refusal.
   */
  sequenceNumber?: number | null;
}

export interface GateContext {
  input: GateInput;
  /** Every message already attached to this lead, newest first. */
  history: HistoryMessage[];
  /**
   * The lead's own `last_contacted_at`, when known.
   *
   * Authoritative when present: it is maintained by `markFollowUpSent` and
   * survives even if history were ever trimmed. The history-derived value is
   * only a fallback.
   */
  lastContactedAt?: string | null;
  /**
   * Imported legacy history for this recipient, resolved by the service from
   * `historical_outreach`. Null (or absent) means nothing is on record.
   *
   * `matchedOn` decides how strong the evidence is: `email` is the canonical
   * identity, `domain` is the secondary company-level guard, and the service
   * never produces `domain` for a shared mailbox provider.
   */
  historicalContact?: HistoricalContact | null;
  /**
   * Facts gathered about the prospect. PEPA stores none yet, so this is
   * normally empty — which is exactly why unbacked personalisation is reported
   * as *missing evidence* rather than as a false statement.
   */
  evidence?: string[];
  /** `now` is injected so cooldown maths is testable and never reads a clock. */
  now?: Date;
}

/* -------------------------------------------------------------------------- */
/* identity semantics — reused, never reinvented                             */
/* -------------------------------------------------------------------------- */

/**
 * A message counts as real outreach once it left the outbox.
 *
 * Mirrors `CONTACTED_STATUSES` in `src/lib/services/lead-service.ts` and the
 * `sent_at IS NOT NULL` test used by the duplicate badge. Kept as its own copy
 * so this pure module stays free of service imports; the two must agree, so a
 * change to one is a change to both.
 */
export const CONTACTED_STATUSES: ReadonlySet<string> = new Set([
  "sent",
  "follow_up",
  "replied",
]);

/**
 * How recent a contact blocks a further send.
 *
 * Deliberately derived from the existing follow-up cadence rather than picked
 * to look reasonable: `FOLLOW_UP_CADENCE_DAYS` starts at 4 days, so a
 * cadence-driven re-send is never more than ~4 days out. A cooldown below that
 * first step blocks genuine accidental double-sends (same day, next morning)
 * without ever standing in the way of the follow-up flow the product depends
 * on. Raising it much above 4 days would block the re-send that the follow-up
 * notification exists to prompt.
 */
export const CONTACT_COOLDOWN_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* similarity thresholds                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Thresholds are heuristics, not statistics.
 *
 * They are set from the two failure modes that matter and are pinned by tests:
 * a reworded repeat must be caught, and a genuinely different email must pass.
 * They are deliberately not presented as a probability of duplication.
 */
export const SUBJECT_HIGH_SIMILARITY = 0.85;
export const SUBJECT_SIMILARITY_FLOOR = 0.6;

export const BODY_HIGH_SIMILARITY = 0.9;
export const BODY_SIMILARITY_FLOOR = 0.65;

/**
 * Below this many tokens a comparison is meaningless: two short strings share
 * tokens by accident. Exact-equality blocking still applies at any length.
 */
export const MIN_TOKENS_FOR_SIMILARITY = 4;

/**
 * Containment (`intersection / min(|A|,|B|)`) is what catches a reworded repeat
 * such as "Krátký dotaz ohledně AI recepce pro váš salon" against "AI recepce
 * pro váš salon" — every token of the shorter text survives inside the longer
 * one.
 *
 * It is also badly wrong when the two texts differ wildly in length: a 40-token
 * pitch sitting inside a 600-token email scores 1.0 while being almost nothing
 * alike. So containment is only trusted when the two are comparable in size.
 */
export const MIN_LENGTH_RATIO_FOR_CONTAINMENT = 0.6;

/* -------------------------------------------------------------------------- */
/* normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fold text to a comparable form.
 *
 * Case, diacritics and punctuation are removed and whitespace collapsed.
 * Diacritics matter here: Czech outreach regenerated by a model flips between
 * "váš" and "vas" freely, and that alone must not disguise a repeat.
 */
export function normalizeForComparison(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Tokenise normalised text. Returns unique tokens, order-independent. */
export function tokenize(input: string | null | undefined): string[] {
  const normalized = normalizeForComparison(input);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(" ").filter(Boolean)));
}

/* -------------------------------------------------------------------------- */
/* similarity                                                                 */
/* -------------------------------------------------------------------------- */

export interface SimilarityBreakdown {
  /** Intersection over union. */
  jaccard: number;
  /** Intersection over the smaller set, or 0 when the sizes are incomparable. */
  containment: number;
  /** The score the gate actually uses: max of the applicable measures. */
  score: number;
  /** True when containment was ignored because the texts differ too much in size. */
  containmentIgnored: boolean;
}

/**
 * Deterministic similarity between two texts.
 *
 * Three cheap measures, combined by taking the maximum:
 *
 *   * Jaccard — set overlap. Robust, order-insensitive, the default.
 *   * Containment — catches a shorter text fully absorbed by a longer one, but
 *     only when their lengths are comparable (see the constant's comment).
 * Character-level edit distance was tried and removed: it scored two entirely
 * unrelated sentences at 0.38, which is pure noise, and every case it would have
 * caught (a reworded repeat, a reordered clause) is already a token-overlap case.
 *
 * No embeddings, no vector store, no model call: this has to stay cheap enough
 * to run on every keystroke-driven draft check.
 */
export function similarity(a: string, b: string): SimilarityBreakdown {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.length === 0 || tokensB.length === 0) {
    return {
      jaccard: 0,
      containment: 0,
      score: 0,
      containmentIgnored: false,
    };
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;

  const union = setA.size + setB.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;

  const smaller = Math.min(setA.size, setB.size);
  const lengthRatio = smaller / Math.max(setA.size, setB.size);
  const containmentIgnored = lengthRatio < MIN_LENGTH_RATIO_FOR_CONTAINMENT;
  const containment =
    smaller === 0 || containmentIgnored || tokensA.length < MIN_TOKENS_FOR_SIMILARITY
      ? 0
      : intersection / smaller;

  const score = Math.max(jaccard, containment);

  return { jaccard, containment, score, containmentIgnored };
}

/* -------------------------------------------------------------------------- */
/* placeholder / AI artefact detection                                        */
/* -------------------------------------------------------------------------- */

export interface PatternHit {
  /** The literal pattern, safe to show the operator. */
  label: string;
  /** Where it was found, for a precise message. */
  field: "subject" | "body";
}

/**
 * Unfilled template markers.
 *
 * These are unambiguous: a delivered cold email containing `{{company}}` is a
 * bug, never a stylistic choice. Patterns are matched case-insensitively
 * against the raw text so the operator sees the marker they actually typed.
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "[NAME]", pattern: /\[\s*name\s*\]/i },
  { label: "[COMPANY]", pattern: /\[\s*company\s*\]/i },
  { label: "[DOPLŇTE]", pattern: /\[\s*dopl[ňn]te\s*\]/i },
  { label: "[INSERT …]", pattern: /\[\s*insert[^\]]*\]/i },
  { label: "<name>", pattern: /<\s*name\s*>/i },
  { label: "<company>", pattern: /<\s*company\s*>/i },
  { label: "{{name}}", pattern: /\{\{\s*name\s*\}\}/i },
  { label: "{{company}}", pattern: /\{\{\s*company\s*\}\}/i },
  { label: "TODO", pattern: /\bTODO\b/ },
  { label: "TBD", pattern: /\bTBD\b/ },
  { label: "XXX", pattern: /\bX{3,}\b/ },
];

/**
 * Generation scaffolding that must never reach a recipient.
 *
 * These are the phrases a chat model wraps around its output. Sending them
 * tells the prospect the email was machine-generated at the last second, which
 * is the opposite of the personal tone PEPA is trying to protect.
 */
const AI_META_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '"Here is your email"', pattern: /\bhere(?:'s| is| are)\s+(?:your|the)\s+email\b/i },
  { label: '"Sure, here\'s …"', pattern: /\bsure[,!]?\s+here(?:'s| is)\b/i },
  { label: '"As an AI"', pattern: /\bas an ai\b/i },
  { label: '"I hope this email finds you well"', pattern: /\bi hope this (?:email|message) finds you well\b/i },
  { label: '"Please find below"', pattern: /\bplease find (?:below|attached|attached here)\b/i },
  { label: '"Let me know if you have any questions"', pattern: /\blet me know if you (?:have|had) any questions\b/i },
  { label: '"As a language model"', pattern: /\bas a language model\b/i },
  { label: '"I am an AI assistant"', pattern: /\bi'?m an ai (?:assistant|model)\b/i },
  { label: 'internal instruction echo', pattern: /\b(?:system prompt|your task is to|you are a sales|act as a sales)\b/i },
];

/** Raw JSON dumped into the body by a mis-wired pipeline. */
const JSON_ARTIFACT = /^\s*[[{][\s\S]*[\]}]\s*$/;

/** Fenced code block markers. */
const CODE_FENCE = /^\s*```/m;

/** A body too short to be a real cold email. */
export const MIN_BODY_LENGTH = 40;

export function findPlaceholders(subject: string, body: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const scan = (text: string, field: PatternHit["field"]) => {
    for (const { label, pattern } of PLACEHOLDER_PATTERNS) {
      if (pattern.test(text)) hits.push({ label, field });
    }
  };
  scan(subject ?? "", "subject");
  scan(body ?? "", "body");
  return hits;
}

export function findAiMetaArtifacts(subject: string, body: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const scan = (text: string, field: PatternHit["field"]) => {
    for (const { label, pattern } of AI_META_PATTERNS) {
      if (pattern.test(text)) hits.push({ label, field });
    }
  };
  scan(subject ?? "", "subject");
  scan(body ?? "", "body");
  return hits;
}

export function looksLikeJsonArtifact(body: string): boolean {
  return JSON_ARTIFACT.test(body ?? "");
}

export function hasCodeFence(body: string): boolean {
  return CODE_FENCE.test(body ?? "");
}

/* -------------------------------------------------------------------------- */
/* personalisation evidence                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Phrases that assert something specific about the prospect.
 *
 * These are the claims that need evidence. The list is intentionally narrow:
 * a false positive here costs the operator a warning they can dismiss, while a
 * false negative lets an invented fact through.
 */
const PERSONALIZATION_MARKERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '"I noticed"', pattern: /\b(?:i|we) (?:noticed|saw|spotted|found|read)\b/i },
  { label: '"I saw on your website"', pattern: /\bon your (?:web|site|website|home ?page)\b/i },
  { label: '"you recently …"', pattern: /\byou (?:recently|just|now)\b/i },
  { label: '"looking at your …"', pattern: /\b(?:looking|had a look|took a look) at your\b/i },
  { label: '"from what I can see"', pattern: /\bfrom what i (?:can|could) see\b/i },
  { label: '"všiml jsem si"', pattern: /\bvšiml(?:a)? jsem (?:si|vám)\b/i },
  { label: '"na vašem webu"', pattern: /\bna (?:vašem|vase|vasi) (?:webu|webe|stránce)\b/i },
  { label: '"prohlížel jsem"', pattern: /\bprohlížel jsem\b/i },
  { label: '"nedávno jste"', pattern: /\bnedávno jste\b/i },
  { label: '"rozšířili jste"', pattern: /\brozšířili jste\b/i },
];

export interface PersonalizationFinding {
  /** The marker that fired, safe to render. */
  label: string;
  /** Tokens of the claim, for evidence matching. */
  claimTokens: string[];
}

/**
 * Claims the draft makes about the prospect.
 *
 * Only the marked span's neighbourhood is inspected, so ordinary Czech business
 * prose does not trip the detector.
 */
export function findPersonalizationClaims(subject: string, body: string): PersonalizationFinding[] {
  const text = `${subject ?? ""}\n${body ?? ""}`;
  const findings: PersonalizationFinding[] = [];

  for (const { label, pattern } of PERSONALIZATION_MARKERS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const start = Math.max(0, match.index - 40);
    const span = text.slice(start, match.index + 160);
    findings.push({ label, claimTokens: tokenize(span) });
  }

  return findings;
}

/**
 * Is a claim backed by anything in the evidence list?
 *
 * Requires a real token overlap, not merely that evidence exists. With no
 * evidence recorded at all the answer is always "unsupported" — which is the
 * honest answer, and is why the reason text says the evidence is *missing*
 * rather than that the claim is false.
 */
export function isClaimSupported(claim: PersonalizationFinding, evidence: string[]): boolean {
  if (evidence.length === 0) return false;

  const evidenceTokens = new Set<string>();
  for (const fact of evidence) for (const token of tokenize(fact)) evidenceTokens.add(token);

  // Stopwords carry no evidential value, so they are excluded from the overlap.
  const meaningful = claim.claimTokens.filter((token) => !STOPWORDS.has(token));
  if (meaningful.length === 0) return false;

  let overlap = 0;
  for (const token of meaningful) if (evidenceTokens.has(token)) overlap += 1;
  return overlap > 0;
}

/**
 * Czech and English function words. Only used to stop a claim from being
 * "supported" by the word "your" appearing in every evidence note.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "to", "in", "on", "at", "for",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
  "these", "those", "i", "we", "you", "your", "yours", "our", "us", "me", "my", "he", "she", "they",
  "je", "jste", "jsem", "jsme", "a", "v", "na", "se", "si", "s", "z", "do", "to", "o", "u", "ze",
  "pro", "pri", "pod", "nad", "pred", "pres", "po", "a", "ale", "ani", "nebo", "tak", "ktery", "ktera",
  "ktere", "jaky", "jaka", "jake", "svych", "sve", "muj", "muze", "jsme", "jse", "takze", "proto",
]);
/* -------------------------------------------------------------------------- */
/* identity                                                                   */
/* -------------------------------------------------------------------------- */

/** What the gate concluded about who this recipient is. */
export type IdentityState =
  | "new_lead"
  | "existing_draft"
  | "active_outreach"
  | "cooldown"
  | "already_contacted"
  | "duplicate_draft";

export interface IdentityVerdict {
  state: IdentityState;
  contacted: boolean;
  lastContactedAt: string | null;
  /** Days since the last contact, or null when never contacted. */
  daysSinceContact: number | null;
  /** The message the recipient is already working on, if any. */
  duplicateDraft: HistoryMessage | null;
  /** The imported legacy history this verdict relied on, if any. */
  historicalContact: HistoricalContact | null;
}

/**
 * Is this a NEW COLD OUTREACH, or a follow-up inside a sequence already running?
 *
 * The distinction is the whole reason the historical guard is not an infinite
 * block. `sequence_number = 0` is PEPA's definition of the first email to a
 * lead, and a first email to an address that has already been contacted is the
 * mistake this guard exists to prevent — no matter how long ago. A follow-up
 * (`sequence_number > 0`) is not cold outreach: it continues a conversation
 * PEPA itself started, so it is governed by the finite cooldown and the
 * 4/7/10 cadence exactly as before.
 *
 * Unknown (`undefined`/`null`) counts as cold outreach. A draft whose position
 * could not be read must not be treated as a follow-up, because that would turn
 * an unanswerable question into permission.
 */
export function isColdOutreach(sequenceNumber: number | null | undefined): boolean {
  if (sequenceNumber === null || sequenceNumber === undefined) return true;
  const value = Number(sequenceNumber);
  if (!Number.isFinite(value)) return true;
  return value <= 0;
}

function isContacted(message: HistoryMessage): boolean {
  return message.sentAt !== null || CONTACTED_STATUSES.has(message.status);
}

/**
 * Decide the identity/duplicate situation for a draft.
 *
 * Reuses the existing duplicate-badge semantics (`sent_at` or a contacted
 * status) rather than defining a second, competing notion of "already
 * contacted". A draft the operator is currently editing is recognised and
 * excluded, so re-saving it is never mistaken for a fresh duplicate.
 */
export function resolveIdentity(context: GateContext): IdentityVerdict {
  const now = context.now ?? new Date();
  const history = context.history ?? [];

  const current = context.input.messageId
    ? history.find((message) => message.id === context.input.messageId) ?? null
    : null;

  // Everything except the draft being evaluated is genuine prior outreach.
  const prior = history.filter((message) => message.id !== context.input.messageId);
  const contactedMessages = prior.filter(isContacted);

  const latestFromHistory = contactedMessages.reduce<string | null>(
    (latest, message) =>
      message.sentAt && (!latest || message.sentAt > latest) ? message.sentAt : latest,
    null,
  );

  // Imported legacy history is the LAST fallback, not an override: the lead's own
  // `last_contacted_at` stays authoritative and Pep-generated history still wins,
  // so nothing that used to be true about an existing lead changes. What it adds
  // is the case that had no value at all — an address the old account pitched
  // and PEPA has never seen. Its `last_contact` therefore enters the cooldown
  // arithmetic exactly as a Pep-generated `sent_at` would.
  const historical = context.historicalContact ?? null;
  const lastContactedAt =
    context.lastContactedAt ?? latestFromHistory ?? historical?.lastContactAt ?? null;

  let daysSinceContact: number | null = null;
  if (lastContactedAt) {
    const parsed = Date.parse(lastContactedAt);
    if (Number.isFinite(parsed)) {
      daysSinceContact = Math.floor((now.getTime() - parsed) / MS_PER_DAY);
    }
  }

  const contacted = contactedMessages.length > 0 || Boolean(lastContactedAt);

  // The permanent refusal. Deliberately evaluated before every other state: a
  // cold outreach to an address already on record is refused whether or not it
  // is inside the cooldown, and whether or not the cooldown has since expired.
  // The age of the contact is not a defence — that is precisely the leak this
  // closes, since every imported contact older than three days would otherwise
  // be pitchable again.
  const alreadyContacted = historical !== null && isColdOutreach(context.input.sequenceNumber);

  let state: IdentityState;
  if (alreadyContacted) {
    state = "already_contacted";
  } else if (prior.length === 0 && !contacted) {
    state = current ? "duplicate_draft" : "new_lead";
  } else if (current && !contacted) {
    // An existing lead with only drafts: editing it is legitimate work.
    state = "duplicate_draft";
  } else if (contacted && daysSinceContact !== null && daysSinceContact < CONTACT_COOLDOWN_DAYS) {
    state = "cooldown";
  } else if (contacted) {
    state = "active_outreach";
  } else {
    state = "duplicate_draft";
  }

  return {
    state,
    contacted,
    lastContactedAt,
    daysSinceContact,
    duplicateDraft: current,
    historicalContact: historical,
  };
}

/* -------------------------------------------------------------------------- */
/* evaluation                                                                 */
/* -------------------------------------------------------------------------- */

function formatDays(days: number): string {
  return days <= 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * `YYYY-MM-DD`, or a wording that admits the date is unknown.
 *
 * Dates are stored as UTC instants, so this is a truncation rather than a
 * conversion: no reader-local timezone is involved, and two operators in two
 * zones read the same day.
 */
function isoDate(value: string | null | undefined): string {
  if (!value) return "an earlier date";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "an earlier date";
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Percentage with no false precision: one decimal at most. */
function percent(score: number): string {
  return `${Math.round(score * 1000) / 10}%`;
}

function worst(checks: QualityCheck[]): GateStatus {
  if (checks.some((check) => check.status === "block")) return "blocked";
  if (checks.some((check) => check.status === "warn")) return "warning";
  return "ready";
}

/**
 * Compare a draft against every prior message and report the closest match.
 *
 * Only messages that actually went out are compared: re-using the wording of an
 * earlier *draft* that was never sent is not a repeat, and blocking it would
 * punish ordinary iteration.
 */
function bestMatch(
  draft: string,
  history: HistoryMessage[],
  selfId: string | null | undefined,
): { message: HistoryMessage; breakdown: SimilarityBreakdown } | null {
  let best: { message: HistoryMessage; breakdown: SimilarityBreakdown } | null = null;

  for (const message of history) {
    if (message.id === selfId) continue;
    if (!isContacted(message)) continue;

    const breakdown = similarity(draft, message.subject ?? "");
    if (!best || breakdown.score > best.breakdown.score) best = { message, breakdown };
  }

  return best;
}

/** Like `bestMatch`, for a whole-body comparison. */
function bestBodyMatch(
  draft: string,
  history: HistoryMessage[],
  selfId: string | null | undefined,
): { message: HistoryMessage; breakdown: SimilarityBreakdown } | null {
  let best: { message: HistoryMessage; breakdown: SimilarityBreakdown } | null = null;

  for (const message of history) {
    if (message.id === selfId) continue;
    if (!isContacted(message)) continue;
    if (!message.body) continue;

    const breakdown = similarity(draft, message.body);
    if (!best || breakdown.score > best.breakdown.score) best = { message, breakdown };
  }

  return best;
}

function describeMatch(message: HistoryMessage, position: number): string {
  const when = message.sentAt ? message.sentAt.slice(0, 10) : message.createdAt.slice(0, 10);
  return `previous #${position + 1} (${when})`;
}

/**
 * Run every check and produce one verdict.
 *
 * `blocked` wins over `warning`, which wins over `ready`. Warnings are never
 * dropped: they propagate into `checks` so the UI can render them and the send
 * path can require explicit confirmation.
 */
export function evaluateQualityGate(context: GateContext): QualityGateResult {
  const { input, history = [] } = context;
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const checks: QualityCheck[] = [];

  /* -- recipient ---------------------------------------------------------- */

  const recipient = (input.recipient ?? "").trim();
  const recipientProblems: string[] = [];
  if (!recipient) {
    recipientProblems.push("no recipient");
  } else if (/[,;]/.test(recipient)) {
    recipientProblems.push("it looks like a recipient list rather than a single address");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stripDisplayName(recipient))) {
    recipientProblems.push(`"${truncate(recipient, 40)}" is not a valid email address`);
  }

  checks.push(
    recipientProblems.length === 0
      ? { name: "recipient", status: "pass", reason: "Recipient is a single valid address." }
      : {
          name: "recipient",
          status: "block",
          reason: `Recipient cannot be accepted: ${recipientProblems.join("; ")}.`,
        },
  );

  /* -- subject / body presence ------------------------------------------- */

  const subjectPresent = subject.trim().length > 0;
  const bodyPresent = body.trim().length > 0;

  checks.push(
    subjectPresent
      ? { name: "subject_present", status: "pass", reason: "Subject is present." }
      : { name: "subject_present", status: "block", reason: "The subject is empty." },
  );

  /* -- identity / duplicate / cooldown ------------------------------------ */

  const identity = resolveIdentity(context);
  checks.push(identityCheck(identity));

  /* -- subject similarity -------------------------------------------------- */

  checks.push(
    subjectPresent ? subjectCheck(subject, history, input.messageId) : passSkipped("subject_unique"),
  );

  /* -- body similarity ----------------------------------------------------- */

  checks.push(bodyPresent ? bodyCheck(body, history, input.messageId) : passSkipped("body_unique"));

  /* -- body presence and shape -------------------------------------------- */

  checks.push(bodyShapeCheck(body, bodyPresent));

  /* -- placeholders -------------------------------------------------------- */

  const placeholders = findPlaceholders(subject, body);
  checks.push(
    placeholders.length === 0
      ? { name: "placeholders", status: "pass", reason: "No unfilled template markers." }
      : {
          name: "placeholders",
          status: "block",
          reason: `Unfilled placeholder found: ${placeholders
            .map((hit) => `${hit.label} in the ${hit.field}`)
            .join(", ")}.`,
          evidence: placeholders.map((hit) => hit.field),
        },
  );

  /* -- AI artefacts -------------------------------------------------------- */

  const artifacts = findAiMetaArtifacts(subject, body);
  const jsonArtifact = bodyPresent && looksLikeJsonArtifact(body);
  const fence = bodyPresent && hasCodeFence(body);

  checks.push(aiArtifactCheck(artifacts, jsonArtifact, fence));

  /* -- personalisation evidence -------------------------------------------- */

  if (!subjectPresent && !bodyPresent) {
    checks.push(passSkipped("personalization"));
  } else {
    checks.push(personalizationCheck(subject, body, context.evidence ?? []));
  }

  const status = worst(checks);

  return {
    status,
    checks,
    reasons: checks.filter((check) => check.status !== "pass").map((check) => check.reason),
  };
}

function stripDisplayName(input: string): string {
  const bracketed = input.match(/<([^<>]+)>/);
  return (bracketed ? bracketed[1] : input).trim();
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}…`;
}

function passSkipped(name: string): QualityCheck {
  return { name, status: "pass", reason: "Nothing to compare yet." };
}

function identityCheck(identity: IdentityVerdict): QualityCheck {
  const evidence: string[] = [];

  switch (identity.state) {
    case "new_lead":
      return {
        name: "identity",
        status: "pass",
        reason: "New lead — no previous outreach on record.",
      };

    case "duplicate_draft":
      return {
        name: "identity",
        status: "pass",
        reason: "Editing an existing draft for this lead. No prior outreach has gone out.",
      };

    case "cooldown":
      evidence.push(`last contact ${formatDays(identity.daysSinceContact ?? 0)}`);
      if (identity.lastContactedAt) evidence.push(identity.lastContactedAt.slice(0, 10));
      return {
        name: "identity",
        status: "block",
        reason:
          `This lead was contacted ${formatDays(identity.daysSinceContact ?? 0)} ago, inside the ` +
          `${CONTACT_COOLDOWN_DAYS}-day cooldown. Sending again now would be a duplicate contact.`,
        evidence,
      };

    case "active_outreach":
      evidence.push(`last contact ${formatDays(identity.daysSinceContact ?? 0)}`);
      if (identity.lastContactedAt) evidence.push(identity.lastContactedAt.slice(0, 10));
      return {
        name: "identity",
        status: "warn",
        reason:
          `This lead was already contacted ${formatDays(identity.daysSinceContact ?? 0)}. ` +
          `A further email is allowed, but confirm this is a deliberate follow-up.`,
        evidence,
      };

    case "already_contacted":
      return alreadyContactedCheck(identity, evidence);

    default:
      return { name: "identity", status: "pass", reason: "No identity conflict." };
  }
}

/**
 * The permanent refusal, named by date so the operator can judge it.
 *
 * Only the date, the count and the matching identity are exposed. Historical
 * subject lines and company names stay in the database: the operator needs to
 * know *that* a company was already pitched and *when*, not to read the old
 * copy back into a composer where it could be re-sent by accident.
 */
function alreadyContactedCheck(identity: IdentityVerdict, evidence: string[]): QualityCheck {
  const contact = identity.historicalContact;
  const when = isoDate(contact?.lastContactAt);
  const count = contact?.contactCount ?? 1;

  evidence.push(
    when,
    `${count} contact${count === 1 ? "" : "s"} on record`,
    "imported history",
  );

  if (contact?.matchedOn === "domain") {
    return {
      name: "already_contacted",
      status: "block",
      code: ALREADY_CONTACTED_DOMAIN,
      reason:
        `Cannot send outreach: this company domain (${contact.normalizedDomain}) was ` +
        `already contacted on ${when} at ${contact.normalizedEmail}. ` +
        `A second cold pitch to the same company is a duplicate contact.`,
      evidence,
    };
  }

  return {
    name: "already_contacted",
    status: "block",
    code: ALREADY_CONTACTED,
    reason:
      `Cannot send outreach: this email address was already contacted on ${when}. ` +
      `Pepa does not start a new outreach sequence for an address that is already on record.`,
    evidence,
  };
}

function subjectCheck(
  subject: string,
  history: HistoryMessage[],
  selfId: string | null | undefined,
): QualityCheck {
  const best = bestMatch(subject, history, selfId);
  if (!best || best.breakdown.score === 0) {
    return { name: "subject_unique", status: "pass", reason: "Subject is not a repeat of earlier outreach." };
  }

  const where = describeMatch(best.message, best.message.index ?? 0);
  const evidence = [where, `similarity ${percent(best.breakdown.score)}`];

  if (normalizeForComparison(subject) === normalizeForComparison(best.message.subject ?? "")) {
    return {
      name: "subject_unique",
      status: "block",
      reason: `The subject is identical to ${where}. Sending it again would repeat the same outreach.`,
      evidence,
    };
  }

  if (best.breakdown.score >= SUBJECT_HIGH_SIMILARITY) {
    return {
      name: "subject_unique",
      status: "warn",
      reason:
        `The subject is very close to ${where} (${percent(best.breakdown.score)} similar). ` +
        `Reword it so the follow-up reads as new outreach.`,
      evidence,
    };
  }

  if (best.breakdown.score >= SUBJECT_SIMILARITY_FLOOR) {
    return {
      name: "subject_unique",
      status: "warn",
      reason: `The subject resembles ${where} (${percent(best.breakdown.score)} similar). Review before sending.`,
      evidence,
    };
  }

  return {
    name: "subject_unique",
    status: "pass",
    reason: "Subject differs enough from earlier outreach.",
    evidence,
  };
}

function bodyCheck(
  body: string,
  history: HistoryMessage[],
  selfId: string | null | undefined,
): QualityCheck {
  const best = bestBodyMatch(body, history, selfId);
  if (!best || best.breakdown.score === 0) {
    return { name: "body_unique", status: "pass", reason: "Body is not a repeat of earlier outreach." };
  }

  const where = describeMatch(best.message, best.message.index ?? 0);
  // Only the similarity figure and the reference are exposed. Historical bodies
  // are never returned: the operator does not need the old copy rendered in the
  // dashboard to be told the new one repeats it.
  const evidence = [where, `similarity ${percent(best.breakdown.score)}`];

  if (normalizeForComparison(body) === normalizeForComparison(best.message.body ?? "")) {
    return {
      name: "body_unique",
      status: "block",
      reason: `The body is identical to ${where}. This is a copy/paste repeat.`,
      evidence,
    };
  }

  if (best.breakdown.score >= BODY_HIGH_SIMILARITY) {
    return {
      name: "body_unique",
      status: "block",
      reason:
        `The body is ${percent(best.breakdown.score)} identical to ${where}, which reads as ` +
        `copy/paste rather than fresh outreach.`,
      evidence,
    };
  }

  if (best.breakdown.score >= BODY_SIMILARITY_FLOOR) {
    return {
      name: "body_unique",
      status: "warn",
      reason: `The body is ${percent(best.breakdown.score)} similar to ${where}. Check the opening and the call to action.`,
      evidence,
    };
  }

  return {
    name: "body_unique",
    status: "pass",
    reason: "Body differs enough from earlier outreach.",
    evidence,
  };
}

function bodyShapeCheck(body: string, present: boolean): QualityCheck {
  if (!present) {
    return { name: "body_present", status: "block", reason: "The body is empty." };
  }

  const trimmed = body.trim();
  if (trimmed.length < MIN_BODY_LENGTH) {
    return {
      name: "body_present",
      status: "block",
      reason: `The body is only ${trimmed.length} characters — too short to be a real email.`,
      evidence: [`minimum ${MIN_BODY_LENGTH}`],
    };
  }

  return { name: "body_present", status: "pass", reason: "Body has usable length." };
}

function aiArtifactCheck(
  artifacts: PatternHit[],
  jsonArtifact: boolean,
  fence: boolean,
): QualityCheck {
  const problems: string[] = [];
  if (artifacts.length > 0) {
    problems.push(`generation commentary (${artifacts.map((hit) => hit.label).join(", ")})`);
  }
  if (jsonArtifact) problems.push("the body is raw JSON");
  if (fence) problems.push("the body contains a markdown code fence");

  if (problems.length === 0) {
    return { name: "ai_artifacts", status: "pass", reason: "No obvious generation artefacts." };
  }

  return {
    name: "ai_artifacts",
    status: "block",
    reason: `This reads as unfinished AI output: ${problems.join("; ")}.`,
  };
}

function personalizationCheck(
  subject: string,
  body: string,
  evidence: string[],
): QualityCheck {
  const claims = findPersonalizationClaims(subject, body);
  if (claims.length === 0) {
    return {
      name: "personalization",
      status: "pass",
      reason: "No specific claims about the prospect to verify.",
    };
  }

  const unsupported = claims.filter((claim) => !isClaimSupported(claim, evidence));

  if (unsupported.length === 0) {
    return {
      name: "personalization",
      status: "pass",
      reason: "Every specific claim is backed by recorded evidence.",
      evidence: [`${claims.length} claim(s) checked`],
    };
  }

  if (evidence.length === 0) {
    return {
      name: "personalization",
      status: "warn",
      reason:
        `The draft makes ${unsupported.length} specific claim(s) about the prospect ` +
        `(${unsupported.map((claim) => claim.label).join(", ")}), but no evidence is recorded. ` +
        `PEPA cannot confirm these — verify them yourself before sending.`,
      evidence: unsupported.map((claim) => claim.label),
    };
  }

  return {
    name: "personalization",
    status: "warn",
    reason:
      `${unsupported.length} specific claim(s) about the prospect ` +
      `(${unsupported.map((claim) => claim.label).join(", ")}) are not covered by the recorded evidence.`,
    evidence: unsupported.map((claim) => claim.label),
  };
}
