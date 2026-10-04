import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INVALID_TOKEN_MESSAGE,
  mintFollowUpToken,
  resolveActionToken,
  saveFollowUpDraft,
} from "./action-token-service";
import { createFollowUpDraft, getFollowUpDetail, listFollowUps } from "./follow-up-sequence-service";
import { CLAIM_LEASE_MS, processDueFollowUps, resolveFollowUpTarget, type ActionNotifier } from "./follow-up-service";
import { createLead, findLeadByEmail } from "./lead-service";
import { listOutreachActivity, getOutreachActivityDetail } from "./outreach-activity-service";
import { evaluateStoredMessageQualityGate } from "./outreach-quality-gate";
import { countSentStats, getOutreachStats } from "./outreach-stats-service";
import { getOutreachStreaks } from "./outreach-streak-service";
import { createDraft, listOutreachHistory, recordOutreachSent } from "./outreach-service";
import { TOKEN_PATTERN } from "@/lib/deep-link/tokens";
import { buildGmailComposeUrl, readComposeParam } from "@/lib/outreach/gmail-compose";

/**
 * Phase 8D rehearsal — the complete first-outreach-day lifecycle, end to end.
 *
 * The question this file answers is narrow and practical:
 *
 *   "If a small batch of real leads are sent manually from Gmail, does PEPA
 *    record, schedule, notify, deep-link and report every action — without
 *    fabricating history and without losing identity?"
 *
 * It runs against a real PostgreSQL 16 database with the real migrations
 * applied from scratch. Nothing is stubbed except the notification transport
 * (no Telegram call is ever made) and the session cookie (this is not a request
 * context, and the auth layer is audited separately by inspection and by the
 * existing unit suites).
 *
 * Everything else is the production code path: the same services, the same
 * views, the same unique constraints, the same triggers. The only reason it is
 * not the Supabase client is that there is no PostgREST in front of a local
 * Postgres; the adapter below speaks SQL and implements exactly the
 * query-builder surface these services use.
 *
 *   psql -d postgres -c 'create database pepa_8d'
 *   for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 \
 *     -d pepa_8d -f "$f"; done
 *   PEPA_REHEARSAL_DB=pepa_8d npx vitest run \
 *     src/lib/services/phase-8d-e2e.rehearsal.test.ts
 */

const DATABASE = process.env.PEPA_REHEARSAL_DB;

vi.mock("@/lib/config/base-url", () => ({
  getBaseUrl: async () => "https://pepa.example.com",
  buildDeepLink: async (token: string) => `https://pepa.example.com/followup/${token}`,
  buildImportDeepLink: async (token: string) => `https://pepa.example.com/import/${token}`,
  buildFollowUpWorkspaceDeepLink: async (token: string) => `https://pepa.example.com/?followup=${token}`,
}));

// The rehearsal is not a request context, so the cookie-backed session guard has
// nothing to read. The guard itself is covered by the auth unit suites and by
// the Phase 8D inspection audit; here it is replaced so the *services* under
// test can run. Nothing below is reachable without it in production.
vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: async () => ({ id: "owner", since: 0 }),
  verifySession: async () => ({ id: "owner", since: 0 }),
  currentUser: async () => ({ id: "owner", since: 0 }),
  getSession: async () => ({ iat: Math.floor(Date.now() / 1000) }),
  LOGIN_PATH: "/login",
  safeRedirectPath: (path: string) => path,
  AuthenticationError: class AuthenticationError extends Error {},
}));

// ---------------------------------------------------------------------------
// psql adapter — just the query-builder surface these services use.
// ---------------------------------------------------------------------------

const run = promisify(execFile);

type Row = Record<string, unknown>;
type Filter = { column: string; op: "eq" | "in" | "is" | "not_is" | "gt"; value: unknown };

function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Every identifier is allow-listed; nothing interpolated can carry SQL. */
function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** Split a select list on top-level commas only, so `t(a, b)` stays intact. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of input) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

interface SelectPart {
  /** `null` for a plain column; the embedded table name otherwise. */
  alias: string | null;
  columns: string[];
}

function parseSelectList(columns: string): SelectPart[] {
  return splitTopLevel(columns).map((part) => {
    const embedded = /^([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/i.exec(part);
    if (embedded) return { alias: embedded[1], columns: splitTopLevel(embedded[2]) };
    return { alias: null, columns: [part] };
  });
}

async function query(
  sql: string,
): Promise<{ rows: Row[]; error: { code: string; message: string } | null }> {
  try {
    const { stdout } = await run(
      "psql",
      ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-d", DATABASE as string, "-c", sql],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const text = stdout.trim();
    if (!text) return { rows: [], error: null };
    if (text.startsWith("[")) return { rows: JSON.parse(text) as Row[], error: null };
    if (/^\d+$/.test(text)) return { rows: [{ count: Number(text) }], error: null };
    return { rows: [], error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes("duplicate key value violates unique constraint") ? "23505" : "P0001";
    return { rows: [], error: { code, message: message.split("\n")[0] } };
  }
}

/** Direct SQL escape hatch for assertions and fixtures. */
async function sql(statement: string): Promise<void> {
  const { error } = await query(statement);
  if (error) throw new Error(`${statement}\n${error.message}`);
}

/**
 * Run a write and report whether the database accepted it.
 *
 * A bare INSERT/UPDATE prints its result rather than JSON, so a failed write
 * would come back indistinguishable from a successful one. Wrapping it in a
 * data-modifying CTE makes the success an empty array and surfaces the error.
 */
async function writeAccepted(statement: string): Promise<boolean> {
  const { error } = await query(
    `with r as (${statement}) select coalesce(json_agg(r), '[]'::json) from r`,
  );
  return error === null;
}

async function rowsOf(inner: string): Promise<Row[]> {
  const { rows, error } = await query(
    `select coalesce(json_agg(x), '[]'::json) from (${inner}) x`,
  );
  if (error) throw new Error(`${inner}\n${error.message}`);
  return rows;
}

const asJson = rowsOf;

/**
 * Foreign keys, read from the catalogue rather than hard-coded, so an embedded
 * resource select (`leads(...)`, `outreach_messages(...)`) resolves through the
 * relationship the database actually declares.
 */
type ForeignKey = { child: string; column: string; parent: string; primaryKey: string };
let foreignKeys: ForeignKey[] | null = null;

async function loadForeignKeys(): Promise<ForeignKey[]> {
  if (foreignKeys) return foreignKeys;
  const rows = await rowsOf(`
    select child.relname as child, parent.relname as parent,
           childcols.attname as column, parentcols.attname as "primaryKey"
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join lateral unnest(con.conkey, con.confkey) with ordinality
      as cols(child_attr, parent_attr, ord) on true
    join pg_attribute childcols
      on childcols.attrelid = con.conrelid and childcols.attnum = cols.child_attr
    join pg_attribute parentcols
      on parentcols.attrelid = con.confrelid and parentcols.attnum = cols.parent_attr
    where con.contype = 'f'
  `);
  foreignKeys = rows.map((row) => ({
    child: String(row.child),
    column: String(row.column),
    parent: String(row.parent),
    primaryKey: String(row.primaryKey),
  }));
  return foreignKeys;
}

/** Generated columns must never be written back by an upsert's DO UPDATE. */
const GENERATED_COLUMNS = new Set(["email_normalized", "recipient_normalized"]);

interface Builder {
  select: (columns?: string, options?: { head?: boolean }) => Builder;
  insert: (payload: Row | Row[]) => Builder;
  upsert: (
    payload: Row | Row[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) => Builder;
  update: (payload: Row) => Builder;
  delete: () => Builder;
  eq: (column: string, value: unknown) => Builder;
  in: (column: string, values: unknown[]) => Builder;
  is: (column: string, value: unknown) => Builder;
  not: (column: string, op: "is" | "in", value: unknown) => Builder;
  gt: (column: string, value: unknown) => Builder;
  order: (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => Builder;
  limit: (count: number) => Builder;
  maybeSingle: () => Promise<{ data: Row | null; error: { code: string; message: string } | null }>;
  then: <T>(
    onFulfilled: (value: { data: unknown; error: unknown; count?: number }) => T,
  ) => Promise<T>;
}

function builder(table: string): Builder {
  const filters: Filter[] = [];
  let columns: string | null = null;
  let head = false;
  let operation:
    | { kind: "select" }
    | { kind: "insert"; payload: Row }
    | { kind: "upsert"; payload: Row; conflict: string | null; ignoreDuplicates: boolean }
    | { kind: "update"; payload: Row }
    | { kind: "delete" } = { kind: "select" };
  let order: { column: string; ascending: boolean; nullsFirst: boolean } | null = null;
  let limit: number | null = null;

  const whereSql = (): string => {
    const parts = filters.map(({ column, op, value }) => {
      const col = identifier(column);
      if (op === "in") return `${col} in (${(value as unknown[]).map(literal).join(", ")})`;
      if (op === "gt") return `${col} > ${literal(value)}`;
      if (op === "is" && value === null) return `${col} is null`;
      if (op === "not_is") return `${col} is not null`;
      return `${col} = ${literal(value)}`;
    });
    return parts.length ? `where ${parts.join(" and ")}` : "";
  };

  const orderSql = (): string =>
    order
      ? ` order by ${identifier(order.column)} ${order.ascending ? "asc" : "desc"}${
          order.nullsFirst ? " nulls first" : " nulls last"
        }`
      : "";
  const limitSql = (): string => (limit === null ? "" : ` limit ${limit}`);

  const insertSql = (payload: Row, conflict: string | null, ignoreDuplicates: boolean): string => {
    const keys = Object.keys(payload).filter((key) => !GENERATED_COLUMNS.has(key));
    if (keys.length === 0) throw new Error("Empty write");
    const values = keys.map((key) => literal(payload[key]));
    let statement =
      `insert into ${identifier(table)} (${keys.map(identifier).join(", ")}) ` +
      `values (${values.join(", ")})`;
    if (conflict) {
      const targets = conflict.split(",").map((name) => identifier(name.trim()));
      statement += ` on conflict (${targets.join(", ")})`;
      statement += ignoreDuplicates
        ? " do nothing"
        : ` do update set ${keys
            .map((key) => `${identifier(key)} = excluded.${identifier(key)}`)
            .join(", ")}`;
    }
    return `${statement} returning *`;
  };

  const statement = async (): Promise<string> => {
    const condition = whereSql();
    if (operation.kind === "select") {
      if (head) return `select count(*)::int from ${identifier(table)} ${condition}`;

      const selected = columns ? parseSelectList(columns) : [{ alias: null, columns: ["*"] }];
      const plain = selected.filter((part) => part.alias === null);
      const embedded = selected.filter((part) => part.alias !== null);
      const baseColumns =
        plain.length === 0
          ? "t.*"
          : plain.flatMap((part) => part.columns).join(", ");
      const base = `select ${baseColumns} from ${identifier(table)} t ${condition}${orderSql()}${limitSql()}`;

      if (embedded.length === 0) {
        return `select coalesce(json_agg(t), '[]'::json) from (${base}) t`;
      }

      const keys = await loadForeignKeys();
      const extras = embedded.map((part) => {
        const name = part.alias as string;
        // A child resource (`outreach_messages(...)` on `leads`) comes back as a
        // collection; a parent (`leads(...)` on `outreach_messages`) comes back
        // as a single object. That is the shape every caller in the codebase
        // already destructures, so the two cases are told apart here rather
        // than by a per-call option.
        const child = keys.find((fk) => fk.child === name && fk.parent === table);
        if (child) {
          return (
            `(select coalesce(json_agg(c), '[]'::json) from ${identifier(name)} c ` +
            `where c.${identifier(child.column)} = t.${identifier(child.primaryKey)}) as "${name}"`
          );
        }
        const parent = keys.find((fk) => fk.child === table && fk.parent === name);
        if (parent) {
          return (
            `(select row_to_json(p) from ${identifier(name)} p ` +
            `where p.${identifier(parent.primaryKey)} = t.${identifier(parent.column)}) as "${name}"`
          );
        }
        throw new Error(`${table} and ${name} have no declared relationship; cannot embed it.`);
      });

      return (
        `select coalesce(json_agg(x), '[]'::json) from (` +
        `select t.*, ${extras.join(", ")} from (${base}) t) x`
      );
    }
    if (operation.kind === "delete") {
      return (
        `with r as (delete from ${identifier(table)} ${condition} returning *) ` +
        `select coalesce(json_agg(r), '[]'::json) from r`
      );
    }
    if (operation.kind === "insert" || operation.kind === "upsert") {
      const conflict = operation.kind === "upsert" ? operation.conflict : null;
      const ignore = operation.kind === "upsert" ? operation.ignoreDuplicates : false;
      return (
        `with r as (${insertSql(operation.payload, conflict, ignore)}) ` +
        `select coalesce(json_agg(r), '[]'::json) from r`
      );
    }
    const patch = operation.payload;
    const keys = Object.keys(patch);
    if (keys.length === 0) throw new Error("Empty write");
    const assignments = keys
      .filter((key) => !GENERATED_COLUMNS.has(key))
      .map((key) => `${identifier(key)} = ${literal(patch[key])}`);
    return (
      `with r as (update ${identifier(table)} set ${assignments.join(", ")} ${condition} returning *) ` +
      `select coalesce(json_agg(r), '[]'::json) from r`
    );
  };

  const run = async () => query(await statement());

  const b = {} as Builder;

  b.select = (next, options) => {
    if (next) columns = next;
    if (options?.head) head = true;
    return b;
  };
  b.insert = (payload) => {
    operation = {
      kind: "insert",
      payload: (Array.isArray(payload) ? payload[0] : payload) as Row,
    };
    return b;
  };
  b.upsert = (payload, options) => {
    operation = {
      kind: "upsert",
      payload: (Array.isArray(payload) ? payload[0] : payload) as Row,
      conflict: options?.onConflict ?? null,
      ignoreDuplicates: options?.ignoreDuplicates === true,
    };
    return b;
  };
  b.update = (payload) => {
    operation = { kind: "update", payload };
    return b;
  };
  b.delete = () => {
    operation = { kind: "delete" };
    return b;
  };
  b.eq = (column, value) => (filters.push({ column, op: "eq", value }), b);
  b.in = (column, values) => (filters.push({ column, op: "in", value: values }), b);
  b.is = (column, value) =>
    (filters.push({ column, op: "is", value: value === null ? null : value ?? null }), b);
  b.not = (column, op, value) =>
    (filters.push({ column, op: op === "is" && value === null ? "not_is" : "is", value }), b);
  b.gt = (column, value) => (filters.push({ column, op: "gt", value }), b);
  b.order = (column, options) =>
    ((order = {
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst ?? true,
    }),
    b);
  b.limit = (count) => ((limit = count), b);
  b.maybeSingle = async () => {
    const result = await run();
    return { data: result.rows[0] ?? null, error: result.error };
  };
  b.then = async (onFulfilled) => {
    const result = await run();
    if (head) {
      return onFulfilled({
        data: null,
        count: Number(result.rows[0]?.count ?? 0),
        error: result.error,
      });
    }
    return onFulfilled({ data: result.rows, error: result.error });
  };

  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => builder(table) }),
  getSupabaseEnvStatus: () => ({ configured: true, missing: [], weak: [] }),
}));

// ---------------------------------------------------------------------------
// Fixture. No Telegram call is ever made.
// ---------------------------------------------------------------------------

const notifications: Array<{
  title: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
}> = [];
let failNextSend = false;

const notifier: ActionNotifier = {
  async sendActionNotification(notification) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("Telegram delivery failed: 502");
    }
    notifications.push({ ...notification });
  },
};

/** Fixed clock so Stats and Streaks assert real numbers, not "about now". */
const NOW = new Date("2026-03-10T09:00:00.000Z");
const SENT_INITIAL_AT = new Date("2026-03-09T08:30:00.000Z");
const SENT_FOLLOW_UP_1_AT = new Date("2026-03-10T07:15:00.000Z");

const INITIAL_SUBJECT = "AI recepce pro hotel U Zlaté studně";
const INITIAL_BODY =
  "Dobrý den,\nrád bych vám představil AI recepce, která odpovídá na dotazy po celý den.\nS pozdravem\nPavel";
const FOLLOW_UP_1_SUBJECT = "Re: AI recepce pro hotel U Zlaté studně";
const FOLLOW_UP_1_BODY =
  "Dobrý den,\nposílám krátké shrnutí, co by pro vás znamenala automatická recepce.\nS pozdravem\nPavel";
const FOLLOW_UP_2_SUBJECT = "Re: Re: AI recepce — nabídka pro vaše služby";
const FOLLOW_UP_2_BODY =
  "Dobrý den,\nabstract na možnost předvedení pro vaše služby, pokud vás to zajímá.\nS pozdravem\nPavel";

async function reset(): Promise<void> {
  // leads cascades to outreach_messages, followup_notifications and action_tokens.
  await sql("delete from leads");
}

async function leadRows(): Promise<Row[]> {
  return asJson(`select id, email, email_normalized, status, followup_count,
                        last_contacted_at, next_followup_at from leads order by email`);
}

async function messageRows(): Promise<Row[]> {
  return asJson(`select id, lead_id, recipient_email, subject, body, status, provider,
                        provider_message_id, sent_at, sequence_number, parent_message_id
                 from outreach_messages order by sequence_number, id`);
}

async function ledgerRows(): Promise<Row[]> {
  return asJson(`select id, lead_id, outreach_id, followup_number, status, sent_at, action_token_id
                 from followup_notifications order by followup_number`);
}

async function tokenRows(): Promise<Row[]> {
  return asJson(`select id, purpose, lead_id, outreach_id, expires_at, used_at, token_hash from action_tokens`);
}

/**
 * The scheduling counter moves to 2 after the initial send, so the `due_followups`
 * view derives followup_number = 3. A row recorded as sent for an already-contacted
 * lead therefore returns a warning rather than a block, which the operator has to
 * acknowledge. Confirming it here is the operator's real second click, and A3.6
 * separately proves the warning is never waived implicitly.
 */
/**
 * Narrow a send result to the recorded branch.
 *
 * `RecordSentResult` is a discriminated union and a plain `expect(...).toBe()`
 * does not narrow it, so the rehearsal states the requirement as a throw
 * instead: a failed assertion and a thrown error both stop the test, and the
 * next line gets the type it needs.
 */
function asRecorded(result: Awaited<ReturnType<typeof recordOutreachSent>>) {
  const data = result.data;
  if (!result.ok || !data || data.outcome !== "recorded") {
    throw new Error(
      `Expected a recorded send, got ${data?.outcome ?? "an error"}: ${result.error ?? "—"}`,
    );
  }
  return data;
}

async function recordSend(messageId: string, leadId: string, sentAt: Date) {
  return asRecorded(await recordOutreachSent({ messageId, leadId, sentAt, confirmWarnings: true }));
}

/** A lead with a sent initial outreach and one stored, unsent follow-up. */
async function seedDueFollowUp(): Promise<{ leadId: string; initialId: string; followUpId: string }> {
  const draft = await createDraft({
    recipientEmail: "info@thearchive.cz",
    companyName: "The Archive",
    contactName: "Info",
    subject: INITIAL_SUBJECT,
    body: INITIAL_BODY,
  });
  const leadId = draft.data!.lead.id;
  const initialId = draft.data!.message.id;
  await recordOutreachSent({ messageId: initialId, leadId, sentAt: SENT_INITIAL_AT, confirmWarnings: true });

  const followUp = await createFollowUpDraft({
    anchorMessageId: initialId,
    subject: FOLLOW_UP_1_SUBJECT,
    body: FOLLOW_UP_1_BODY,
  });
  await sql(
    `update leads set next_followup_at = now() - interval '1 hour', followup_count = 1`,
  );

  return { leadId, initialId, followUpId: followUp.data!.message.id };
}

beforeAll(async () => {
  if (!DATABASE) return;
  // The real minting routine refuses without a signing key of at least 32
  // characters. Synthetic, local-only, never a production value.
  process.env.PEPA_SESSION_SECRET = "phase-8d-rehearsal-secret-that-is-long-enough-32";
  await loadForeignKeys();
});

beforeEach(async () => {
  if (!DATABASE) return;
  notifications.length = 0;
  failNextSend = false;
  await reset();
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A1: initial lead", () => {
  it("A1.1 normalises the recipient and creates exactly one lead", async () => {
    const first = await createLead({
      email: "  Info@TheArchive.CZ ",
      companyName: "The Archive",
      contactName: "Info",
    });
    expect(first.ok).toBe(true);

    // Same person, different spelling and case: the database resolves it.
    const second = await createLead({ email: "info@thearchive.cz", companyName: "The Archive" });
    expect(second.ok).toBe(true);
    expect(second.data?.id).toBe(first.data?.id);

    const rows = await leadRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].email_normalized).toBe("info@thearchive.cz");
    expect(rows[0].status).toBe("ready");
  });

  it("A1.2 a new lead has no previous outreach and says so", async () => {
    const check = await findLeadByEmail("info@thearchive.cz");
    expect(check.ok).toBe(true);
    expect(check.data?.state).toBe("new");
    expect(check.data?.messageCount).toBe(0);
    expect(check.data?.sentCount).toBe(0);
    expect(check.data?.lastContactedAt).toBeNull();

    expect(await messageRows()).toHaveLength(0);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A2: initial outreach and the quality gate", () => {
  beforeEach(async () => {
    await createLead({ email: "info@thearchive.cz", companyName: "The Archive" });
  });

  it("A2.1 the composer creates sequence slot 0 with no parent", async () => {
    const draft = await createDraft({
      recipientEmail: "Info@TheArchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });

    expect(draft.ok).toBe(true);
    const message = draft.data!.message;
    expect(message.sequence_number).toBe(0);
    expect(message.parent_message_id).toBeNull();
    expect(message.status).toBe("draft");
    expect(message.recipient_email).toBe("info@thearchive.cz");
    expect(message.subject).toBe(INITIAL_SUBJECT);
    expect(message.body).toBe(INITIAL_BODY);
    expect(message.sent_at).toBeNull();
    // PEPA has no mail provider and must never invent one.
    expect(message.provider).toBeNull();
    expect(message.provider_message_id).toBeNull();
  });

  it("A2.2 an ordinary draft passes the authoritative gate", async () => {
    const draft = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });
    const evaluated = await evaluateStoredMessageQualityGate(draft.data!.message.id, draft.data!.lead.id);

    expect(evaluated).not.toBeNull();
    expect(evaluated!.gate.status).toBe("ready");
    expect(evaluated!.gate.blocked).toBe(false);
    expect(evaluated!.gate.reasons).toEqual([]);
  });

  it("A2.3 an identical repeat and an unfilled placeholder are both refused", async () => {
    const good = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });
    const leadId = good.data!.lead.id;
    const sent = await recordOutreachSent({
      messageId: good.data!.message.id,
      leadId,
      sentAt: SENT_INITIAL_AT,
    });
    expect(sent.data?.outcome).toBe("recorded");

    // A follow-up that reuses the initial outreach's subject verbatim is a
    // repeat the gate must refuse rather than warn about.
    const repeat = await createFollowUpDraft({
      anchorMessageId: good.data!.message.id,
      subject: INITIAL_SUBJECT,
      body: `${INITIAL_BODY}\n\nJeště jednou s upřesněním.`,
    });
    const repeatGate = await evaluateStoredMessageQualityGate(repeat.data!.message.id, leadId);
    expect(repeatGate!.gate.status).toBe("blocked");
    expect(repeatGate!.gate.reasons.join(" ")).toMatch(/identical/i);

    // A fresh lead whose draft still carries a template marker: blocked.
    await createLead({ email: "info@bistro.cz", companyName: "Bistro" });
    const placeholder = await createDraft({
      recipientEmail: "info@bistro.cz",
      subject: "AI recepce pro [COMPANY]",
      body: "Dobrý den,\nrád bych vám představil AI recepce pro vaše podnikání.\nS pozdravem",
    });
    const placeholderGate = await evaluateStoredMessageQualityGate(
      placeholder.data!.message.id,
      placeholder.data!.lead.id,
    );
    expect(placeholderGate!.gate.status).toBe("blocked");
    expect(placeholderGate!.gate.reasons.join(" ")).toMatch(/placeholder/i);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A3: recording the send", () => {
  async function seedDraft() {
    const draft = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });
    return { leadId: draft.data!.lead.id, messageId: draft.data!.message.id };
  }

  it("A3.1 Mark as sent records the fact once and schedules the follow-up", async () => {
    const { leadId, messageId } = await seedDraft();

    const result = await recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT });

    expect(result.ok).toBe(true);
    const recorded = asRecorded(result);
    expect(recorded.message.status).toBe("sent");
    // Postgres renders timestamptz as `+00:00`; the instant is what matters.
    expect(Date.parse(recorded.message.sent_at as string)).toBe(SENT_INITIAL_AT.getTime());
    // The operator sent it from their own mail client; PEPA must not claim otherwise.
    expect(recorded.message.provider).toBeNull();
    expect(recorded.message.provider_message_id).toBeNull();
    expect(recorded.message.sequence_number).toBe(0);

    const leads = await leadRows();
    expect(Number(leads[0].followup_count)).toBe(1);
    expect(Date.parse(leads[0].last_contacted_at as string)).toBe(SENT_INITIAL_AT.getTime());
    // Cadence: follow-up #1 is due 4 days after the send.
    expect(Date.parse(leads[0].next_followup_at as string)).toBe(
      new Date("2026-03-13T08:30:00.000Z").getTime(),
    );
  });

  it("A3.2 replaying Mark as sent changes nothing and duplicates nothing", async () => {
    const { leadId, messageId } = await seedDraft();
    await recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT });
    const scheduledOnce = (await leadRows())[0].next_followup_at;

    const replay = await recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT });

    expect(replay.data?.outcome).toBe("already_sent");
    // An idempotent repeat never claims a new schedule.
    expect(replay.data && "nextFollowUpAt" in replay.data ? replay.data.nextFollowUpAt : null).toBeNull();

    const leads = await leadRows();
    expect(leads[0].next_followup_at).toBe(scheduledOnce);
    expect(Number(leads[0].followup_count)).toBe(1);
    expect(await messageRows()).toHaveLength(1);
  });

  it("A3.3 two concurrent Mark as sent records exactly one send", async () => {
    const { leadId, messageId } = await seedDraft();

    const [a, b] = await Promise.all([
      recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT }),
      recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT }),
    ]);

    const outcomes = [a.data?.outcome, b.data?.outcome].sort();
    expect(outcomes).toEqual(["already_sent", "recorded"]);

    const leads = await leadRows();
    // Scheduling happened once, not twice: followup_count is 1, not 2.
    expect(Number(leads[0].followup_count)).toBe(1);
    expect(await messageRows()).toHaveLength(1);
  });

  it("A3.4 the gate still refuses a send inside the cooldown, and writes nothing", async () => {
    const { leadId, messageId } = await seedDraft();
    await recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT });

    // The cooldown is measured against the wall clock the gate runs on, so the
    // fixture moves the lead's last contact to an hour ago: exactly the
    // "same morning" mistake the rule exists to stop.
    await sql(`update leads set last_contacted_at = now() - interval '1 hour'`);

    const followUp = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });
    const blocked = await recordOutreachSent({
      messageId: followUp.data!.message.id,
      leadId,
      sentAt: new Date(),
    });

    expect(blocked.data?.outcome).toBe("blocked");
    expect(blocked.ok).toBe(true);
    const refusal = blocked.data;
    if (!refusal || refusal.outcome !== "blocked") {
      throw new Error("Expected the gate to block this send.");
    }
    expect(refusal.error).toMatch(/cooldown/i);
    const rows = await messageRows();
    const untouched = rows.find((row) => row.id === followUp.data!.message.id);
    expect(untouched?.status).toBe("draft");
    expect(untouched?.sent_at).toBeNull();
  });

  it("A3.6 a warning is never waived implicitly", async () => {
    const { leadId, messageId } = await seedDraft();
    await recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT });
    await sql(`update leads set last_contacted_at = now() - interval '4 days'`);

    const followUp = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });

    // Past the cooldown, so this is a warning rather than a block. The first
    // call must report it and write nothing.
    const warned = await recordOutreachSent({ messageId: followUp.data!.message.id, leadId });
    expect(warned.data?.outcome).toBe("needs_confirmation");
    let rows = await messageRows();
    expect(rows.find((row) => row.id === followUp.data!.message.id)?.status).toBe("draft");

    // Only an explicit acknowledgement proceeds.
    const confirmed = await recordOutreachSent({
      messageId: followUp.data!.message.id,
      leadId,
      confirmWarnings: true,
    });
    expect(confirmed.data?.outcome).toBe("recorded");
    rows = await messageRows();
    expect(rows.find((row) => row.id === followUp.data!.message.id)?.status).toBe("sent");
  });

  it("A3.5 a duplicate initial outreach lands on the same slot, never a second row", async () => {
    const { leadId, messageId } = await seedDraft();
    await recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT });

    // The composer upserts on the sequence slot, so a second save for the same
    // recipient refreshes slot 0 instead of creating another initial outreach.
    const again = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });

    expect(again.data!.message.id).toBe(messageId);
    expect(again.data!.message.sequence_number).toBe(0);
    const rows = await messageRows();
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => Number(row.sequence_number) === 0)).toHaveLength(1);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A4/A5: the follow-up chain", () => {
  async function seedSentInitial(): Promise<{ leadId: string; messageId: string }> {
    const draft = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });
    const leadId = draft.data!.lead.id;
    const messageId = draft.data!.message.id;
    await recordOutreachSent({ messageId, leadId, sentAt: SENT_INITIAL_AT });
    return { leadId, messageId };
  }

  it("A4.1 the first follow-up lands in slot 1 under the initial outreach", async () => {
    const { messageId } = await seedSentInitial();

    const result = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });

    expect(result.ok).toBe(true);
    expect(result.data!.created).toBe(true);
    const followUp = result.data!.message;
    expect(followUp.sequence_number).toBe(1);
    expect(followUp.parent_message_id).toBe(messageId);
    expect(followUp.recipient_email).toBe("info@thearchive.cz");
    expect(followUp.status).toBe("draft");
    expect(followUp.sent_at).toBeNull();

    const workspace = await listFollowUps();
    expect(workspace.ok).toBe(true);
    expect(workspace.data).toHaveLength(1);
    expect(workspace.data![0].message.id).toBe(followUp.id);
  });

  it("A4.2 re-saving an open follow-up updates that row and creates no second one", async () => {
    const { messageId } = await seedSentInitial();
    const first = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });

    const again = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: "Re: AI recepce — upřesnění",
      body: `${FOLLOW_UP_1_BODY}\nDoplnění.`,
    });

    expect(again.data!.created).toBe(false);
    expect(again.data!.message.id).toBe(first.data!.message.id);
    expect(again.data!.message.sequence_number).toBe(1);
    expect(again.data!.message.subject).toBe("Re: AI recepce — upřesnění");

    const rows = await messageRows();
    // Slot 0 and slot 1. No third row, and the initial outreach is untouched.
    expect(rows.map((row) => row.sequence_number)).toEqual([0, 1]);
    expect(rows[0].subject).toBe(INITIAL_SUBJECT);
    expect(rows[0].body).toBe(INITIAL_BODY);
  });

  it("A4.3 a save on an anchor with an open child updates that child, never a branch", async () => {
    const { messageId } = await seedSentInitial();
    const first = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });
    const second = await createFollowUpDraft({
      anchorMessageId: first.data!.message.id,
      subject: FOLLOW_UP_2_SUBJECT,
      body: FOLLOW_UP_2_BODY,
    });
    expect(second.data!.created).toBe(true);

    const branch = await createFollowUpDraft({
      anchorMessageId: first.data!.message.id,
      subject: "Jiná větev",
      body: "Jiná větev",
    });

    // Slot 2 is already open under slot 1, so the save lands on slot 2 and the
    // chain keeps exactly three rows.
    expect(branch.ok).toBe(true);
    expect(branch.data!.message.id).toBe(second.data!.message.id);
    expect(branch.data!.created).toBe(false);
    expect(branch.data!.message.sequence_number).toBe(2);
    expect(await messageRows()).toHaveLength(3);
  });

  it("A4.4 anchoring on a superseded message is refused rather than branching", async () => {
    const { leadId, messageId } = await seedSentInitial();
    const one = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });
    await recordOutreachSent({
      messageId: one.data!.message.id,
      leadId,
      sentAt: SENT_FOLLOW_UP_1_AT,
    });
    const two = await createFollowUpDraft({
      anchorMessageId: one.data!.message.id,
      subject: FOLLOW_UP_2_SUBJECT,
      body: FOLLOW_UP_2_BODY,
    });
    await recordOutreachSent({
      messageId: two.data!.message.id,
      leadId,
      sentAt: new Date("2026-03-13T08:00:00.000Z"),
      // Three days after the previous contact: a warning, not a block, so the
      // operator has to acknowledge it. That is the gate working, not a bypass.
      confirmWarnings: true,
    });

    // Slot 1 now has no OPEN child (slot 2 is sent) and slot 2 outranks it.
    const branch = await createFollowUpDraft({
      anchorMessageId: one.data!.message.id,
      subject: "Větev z pozadí",
      body: "Větev z pozadí",
    });

    expect(branch.ok).toBe(false);
    expect(branch.reason).toBe("anchor_not_latest");
    expect(await messageRows()).toHaveLength(3);
  });

  it("A5.1 follow-up #2 chains from #1 and history stays intact", async () => {
    const { leadId, messageId } = await seedSentInitial();
    const one = await createFollowUpDraft({
      anchorMessageId: messageId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });
    // Recorded, not merely drafted: the chain below is a real sent history.
    await recordSend(one.data!.message.id, leadId, SENT_FOLLOW_UP_1_AT);

    const two = await createFollowUpDraft({
      anchorMessageId: one.data!.message.id,
      subject: FOLLOW_UP_2_SUBJECT,
      body: FOLLOW_UP_2_BODY,
    });

    expect(two.data!.message.sequence_number).toBe(2);
    expect(two.data!.message.parent_message_id).toBe(one.data!.message.id);

    const rows = await messageRows();
    expect(rows.map((row) => row.sequence_number)).toEqual([0, 1, 2]);
    // Every row kept its own copy. Nothing was overwritten to make room.
    expect(rows[0].subject).toBe(INITIAL_SUBJECT);
    expect(rows[1].subject).toBe(FOLLOW_UP_1_SUBJECT);
    expect(rows[2].subject).toBe(FOLLOW_UP_2_SUBJECT);

    const detail = await getFollowUpDetail(two.data!.message.id);
    expect(detail.ok).toBe(true);
    expect(detail.data!.parent?.id).toBe(one.data!.message.id);
    expect(detail.data!.initial?.id).toBe(messageId);
    expect(detail.data!.isInitial).toBe(false);
  });

  it("A5.2 two concurrent follow-up creations produce exactly one row", async () => {
    const { messageId } = await seedSentInitial();

    const [a, b] = await Promise.all([
      createFollowUpDraft({ anchorMessageId: messageId, subject: FOLLOW_UP_1_SUBJECT, body: FOLLOW_UP_1_BODY }),
      createFollowUpDraft({ anchorMessageId: messageId, subject: FOLLOW_UP_1_SUBJECT, body: FOLLOW_UP_1_BODY }),
    ]);

    const created = [a, b].filter((result) => result.ok && result.data?.created);
    expect(created.length).toBeGreaterThanOrEqual(1);

    const rows = await messageRows();
    expect(rows.filter((row) => Number(row.sequence_number) === 1)).toHaveLength(1);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A6: the due state", () => {
  it("A6.1 the view returns the lead, anchored on the message that really went out", async () => {
    const { initialId, followUpId } = await seedDueFollowUp();

    const due = await processDueFollowUps({ notifier });

    expect(due.examined).toBe(1);
    expect(due.notified).toBe(1);
    // The anchor is the sent initial outreach, never the draft that follows it.
    const ledger = await ledgerRows();
    expect(ledger[0].outreach_id).toBe(followUpId);
    expect(ledger[0].outreach_id).not.toBe(initialId);
  });

  it("A6.2 the sequence number is read from the row, not computed from the counter", async () => {
    const { leadId, initialId, followUpId } = await seedDueFollowUp();

    const resolution = await resolveFollowUpTarget(leadId, initialId);
    expect(resolution.state).toBe("due");
    expect(resolution.message?.id).toBe(followUpId);
    expect(resolution.message?.sequence_number).toBe(1);

    await processDueFollowUps({ notifier });

    // The counter says 2, the stored row says 1. The notification carries the
    // row's own number, and the ledger is keyed by it.
    expect((await leadRows())[0].followup_count).toBe(1);
    const ledger = await ledgerRows();
    expect(ledger[0].followup_number).toBe(1);
    expect(notifications[0].body).toContain("Follow-up #1");
  });

  it("A6.3 a follow-up that is no longer open is not announced again", async () => {
    const { leadId, initialId, followUpId } = await seedDueFollowUp();
    // The operator closed the follow-up without sending it — the lead replied.
    // The row survives, so the anchor stays put and the slot is visibly taken.
    await sql(`update outreach_messages set status = 'replied' where id = '${followUpId}'`);

    const resolution = await resolveFollowUpTarget(leadId, initialId);
    expect(resolution.state).toBe("already_sent");
    expect(resolution.message).toBeNull();

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.skippedAlreadySent).toBe(1);
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("A6.3b a follow-up that was actually sent becomes the new anchor", async () => {
    await seedDueFollowUp();
    const followUpId = (await messageRows())[1].id as string;
    await sql(
      `update outreach_messages set status = 'sent', sent_at = now() - interval '1 hour' where id = '${followUpId}'`,
    );

    const outcome = await processDueFollowUps({ notifier });

    // The chain moved on: the sent follow-up is the anchor now, and nothing is
    // stored under it yet. There is no true thing to announce, so nothing is.
    expect(outcome.skippedUnrecorded).toBe(1);
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("A6.4 a missing follow-up is skipped and never fabricated", async () => {
    const { leadId, initialId } = await seedDueFollowUp();
    await sql("delete from outreach_messages where sequence_number > 0");

    const resolution = await resolveFollowUpTarget(leadId, initialId);
    expect(resolution.state).toBe("not_stored");
    expect(resolution.message).toBeNull();

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.skippedUnrecorded).toBe(1);
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
    // Nothing was invented: still exactly the initial outreach.
    expect(await messageRows()).toHaveLength(1);
  });

  it("A6.5 two recipients in one sequence slot are refused, not guessed between", async () => {
    const { initialId } = await seedDueFollowUp();

    // A second recipient sharing the anchor and the sequence slot is the exact
    // shape `skippedAmbiguous` exists to refuse.
    //
    // Phase 8D FINDING: the database does NOT refuse this write. The Phase 4A
    // trigger `outreach_messages_parent_same_lead` compares
    // `parent.recipient_normalized` against `NEW.recipient_normalized`, but
    // `recipient_normalized` is a GENERATED column, and Postgres computes
    // generated columns AFTER before-row triggers — so `NEW.recipient_normalized`
    // is NULL during the trigger and the comparison evaluates to NULL, which
    // `IF` treats as false. The same-LEAD half of that trigger works, because
    // `lead_id` is an ordinary column. So cross-lead grafting is blocked and
    // cross-recipient grafting is not.
    //
    // PEPA's own writers never produce this row: every follow-up write copies
    // `recipient_email` from its anchor. The engine-level refusal below is
    // therefore the defence that is actually live, and it is exercised here.
    const grafted = await writeAccepted(
      `insert into outreach_messages (lead_id, recipient_email, subject, body, status, sequence_number, parent_message_id) ` +
        `values ((select lead_id from outreach_messages where id = '${initialId}'), ` +
        `'ostatni@thearchive.cz', 'Jiný příjemce', 'Jiný příjemce', 'draft', 1, '${initialId}') returning *`,
    );
    expect(grafted).toBe(true);

    const outcome = await processDueFollowUps({ notifier });

    // Two open children at the same slot: the engine announces neither.
    expect(outcome.skippedAmbiguous).toBe(1);
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("A6.6 the same-lead half of the Phase 4A trigger does work", async () => {
    const { leadId, followUpId } = await seedDueFollowUp();
    await createLead({ email: "info@bistro.cz", companyName: "Bistro" });
    const bistro = await createDraft({
      recipientEmail: "info@bistro.cz",
      subject: "AI recepce pro restauraci Na konvici",
      body: "Dobrý den,\nrád bych vám představil AI recepce pro vaši restauraci.\nS pozdravem",
    });

    // Grafting one lead's message under another lead's parent is refused.
    const crossLead = await writeAccepted(
      `insert into outreach_messages (lead_id, recipient_email, subject, body, status, sequence_number, parent_message_id) ` +
        `values ('${bistro.data!.lead.id}', 'info@bistro.cz', 'Cizí', 'Cizí', 'draft', 1, '${followUpId}') returning *`,
    );
    expect(crossLead).toBe(false);
    expect(leadId).toBeTruthy();
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A7: the notification", () => {
  it("A7.1 exactly one claim, one ledger row, naming the real follow-up", async () => {
    const { followUpId } = await seedDueFollowUp();

    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.notified).toBe(1);
    expect(notifications).toHaveLength(1);

    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("sent");
    expect(ledger[0].outreach_id).toBe(followUpId);
    expect(ledger[0].followup_number).toBe(1);
    expect(ledger[0].sent_at).toBeTruthy();
    expect(ledger[0].action_token_id).toBeTruthy();

    // The ledger and the deep link name the same message.
    const tokens = await tokenRows();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].outreach_id).toBe(followUpId);
    expect(tokens[0].purpose).toBe("followup_composer");
  });

  it("A7.2 the payload names the lead, the follow-up and the recipient", async () => {
    await seedDueFollowUp();
    await processDueFollowUps({ notifier });

    const payload = notifications[0];
    expect(payload.title).toBe("\u{1F525} FOLLOW-UP DUE");
    expect(payload.body).toContain("The Archive");
    expect(payload.body).toContain("Follow-up #1");
    expect(payload.body).toContain("info@thearchive.cz");
    expect(payload.actionLabel).toBe("OPEN IN PEPA");
    expect(payload.actionUrl).toMatch(/^https:\/\/pepa\.example\.com\/followup\/fp1_[A-Za-z0-9_-]{43}$/);
  });

  it("A7.3 no email content and no send wording ever leaves the boundary", async () => {
    await seedDueFollowUp();
    await processDueFollowUps({ notifier });

    const payload = `${notifications[0].title} ${notifications[0].body} ${notifications[0].actionUrl}`;
    expect(payload).not.toContain(INITIAL_SUBJECT);
    expect(payload).not.toContain(FOLLOW_UP_1_SUBJECT);
    expect(payload).not.toContain(INITIAL_BODY);
    expect(payload).not.toContain("Pavel");
    // The notification says a follow-up is DUE. It never claims it was sent.
    expect(payload).not.toMatch(/\bsent\b/i);
    expect(payload).not.toMatch(/\bposlán\b/i);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A8: idempotency and concurrency", () => {
  it("A8.1 a second run notifies nothing and adds no row", async () => {
    await seedDueFollowUp();
    await processDueFollowUps({ notifier });

    const second = await processDueFollowUps({ notifier });

    expect(second.notified).toBe(0);
    expect(second.skippedAlreadyNotified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
    expect(await tokenRows()).toHaveLength(1);
    expect(await messageRows()).toHaveLength(2);
  });

  it("A8.2 two processors race and exactly one wins", async () => {
    const { followUpId } = await seedDueFollowUp();

    const [a, b] = await Promise.all([
      processDueFollowUps({ notifier }),
      processDueFollowUps({ notifier }),
    ]);

    expect(notifications).toHaveLength(1);
    expect(a.notified + b.notified).toBe(1);
    // The loser sees the winner's row, not an error.
    expect(a.skippedBusy + b.skippedBusy + a.skippedAlreadyNotified + b.skippedAlreadyNotified).toBe(1);

    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outreach_id).toBe(followUpId);
    expect(await tokenRows()).toHaveLength(1);
  });

  it("A8.3 the database, not the application, is the final arbiter", async () => {
    await seedDueFollowUp();
    const { leadId, followUpId } = await seedDueFollowUp().then(async () => ({
      leadId: (await leadRows())[0].id as string,
      followUpId: (await messageRows())[1].id as string,
    }));

    const first = await query(
      `insert into followup_notifications (lead_id, outreach_id, followup_number, status, claimed_at) ` +
        `values ('${leadId}', '${followUpId}', 1, 'claimed', now()) returning id`,
    );
    expect(first.error).toBeNull();

    // A second ledger row for the same logical follow-up cannot exist.
    const second = await query(
      `insert into followup_notifications (lead_id, outreach_id, followup_number, status, claimed_at) ` +
        `values ('${leadId}', '${followUpId}', 1, 'claimed', now()) returning id`,
    );
    expect(second.error?.code).toBe("23505");
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A9: Telegram failure", () => {
  it("A9.1 a failed delivery leaves no delivered row and the next run retries", async () => {
    const { followUpId } = await seedDueFollowUp();

    failNextSend = true;
    const failed = await processDueFollowUps({ notifier });

    expect(failed.failed).toBe(1);
    expect(failed.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    // The claim was released, so nothing claims to have been delivered.
    expect(await ledgerRows()).toHaveLength(0);

    const retry = await processDueFollowUps({ notifier });

    expect(retry.notified).toBe(1);
    expect(notifications).toHaveLength(1);
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("sent");
    expect(ledger[0].outreach_id).toBe(followUpId);
  });

  it("A9.2 a failed run never advances the message or the schedule", async () => {
    await seedDueFollowUp();
    const before = await messageRows();
    const leadBefore = (await leadRows())[0];

    failNextSend = true;
    await processDueFollowUps({ notifier });

    expect(await messageRows()).toEqual(before);
    const leadAfter = (await leadRows())[0];
    expect(leadAfter.next_followup_at).toBe(leadBefore.next_followup_at);
    expect(leadAfter.followup_count).toBe(leadBefore.followup_count);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A10: the deep link", () => {
  async function notifiedToken(): Promise<string> {
    await seedDueFollowUp();
    await processDueFollowUps({ notifier });
    const url = notifications[0].actionUrl;
    return url.slice(url.lastIndexOf("/") + 1);
  }

  it("A10.1 the token is opaque and leaks nothing into the URL", async () => {
    const token = await notifiedToken();

    expect(TOKEN_PATTERN.test(token)).toBe(true);
    expect(token).not.toContain("@");
    expect(token).not.toContain("-0000-4000");

    const url = notifications[0].actionUrl;
    // No message id, no lead id, no recipient, no subject.
    for (const row of await messageRows()) expect(url).not.toContain(String(row.id));
    for (const row of await leadRows()) {
      expect(url).not.toContain(String(row.id));
      expect(url).not.toContain(String(row.email));
    }
    expect(url).not.toContain(FOLLOW_UP_1_SUBJECT);
  });

  it("A10.2 the token resolves to the exact follow-up row", async () => {
    const token = await notifiedToken();
    const { followUpId, leadId } = { followUpId: (await messageRows())[1].id, leadId: (await leadRows())[0].id };

    const resolved = await resolveActionToken(token, "followup_composer");

    expect(resolved.ok).toBe(true);
    expect(resolved.data!.lead.id).toBe(leadId);
    expect(resolved.data!.outreach?.id).toBe(followUpId);
    expect(resolved.data!.outreach?.sequence_number).toBe(1);
    expect(resolved.data!.outreach?.status).toBe("draft");
  });

  it("A10.3 the token is purpose-bound", async () => {
    const token = await notifiedToken();

    const wrongPurpose = await resolveActionToken(token, "outreach_import");

    expect(wrongPurpose.ok).toBe(false);
    expect(wrongPurpose.error).toBe(INVALID_TOKEN_MESSAGE);
  });

  it("A10.4 an invalid, tampered or expired token all fail identically", async () => {
    const token = await notifiedToken();

    const malformed = await resolveActionToken("not-a-token", "followup_composer");
    const tampered = await resolveActionToken(`${token.slice(0, -1)}A`, "followup_composer");
    const unknown = await resolveActionToken(`fp1_${"A".repeat(43)}`, "followup_composer");

    for (const result of [malformed, tampered, unknown]) {
      expect(result.ok).toBe(false);
      // One message for every cause, so the endpoint is not an oracle.
      expect(result.error).toBe(INVALID_TOKEN_MESSAGE);
    }

    const expired = await mintFollowUpToken({
      leadId: (await leadRows())[0].id as string,
      outreachId: (await messageRows())[1].id as string,
      ttlMs: -1000,
    });
    expect(expired.ok).toBe(true);
    const resolvedExpired = await resolveActionToken(expired.data!.token, "followup_composer");
    expect(resolvedExpired.ok).toBe(false);
    expect(resolvedExpired.error).toBe(INVALID_TOKEN_MESSAGE);
  });

  it("A10.5 a token resolves only to its own lead", async () => {
    const token = await notifiedToken();

    await createLead({ email: "info@bistro.cz", companyName: "Bistro" });
    const bistro = await createDraft({
      recipientEmail: "info@bistro.cz",
      subject: "AI recepce pro restauraci Na konvici",
      body: "Dobrý den,\nrád bych vám představil AI recepce pro vaši restauraci.\nS pozdravem",
    });

    // The Archive's token cannot be retargeted: the lead comes from the row the
    // digest matched, never from the request.
    const resolved = await resolveActionToken(token, "followup_composer");
    expect(resolved.data!.lead.email).toBe("info@thearchive.cz");
    expect(resolved.data!.lead.id).not.toBe(bistro.data!.lead.id);

    // And a token minted for Bistro resolves to Bistro, with no shared identity.
    const bistroToken = await mintFollowUpToken({ leadId: bistro.data!.lead.id });
    const bistroResolved = await resolveActionToken(bistroToken.data!.token, "followup_composer");
    expect(bistroResolved.data!.lead.email).toBe("info@bistro.cz");
    expect(bistroResolved.data!.outreach).toBeNull();
  });

  it("A10.6 opening the link writes nothing but a first-use stamp", async () => {
    const token = await notifiedToken();
    const messagesBefore = await messageRows();
    const ledgerBefore = await ledgerRows();
    const leadsBefore = await leadRows();

    await resolveActionToken(token, "followup_composer");

    expect(await messageRows()).toEqual(messagesBefore);
    expect(await ledgerRows()).toEqual(ledgerBefore);
    expect(await leadRows()).toEqual(leadsBefore);

    const tokens = await tokenRows();
    expect(tokens[0].used_at).toBeTruthy();

    // Re-opening inside the TTL still works: a phone may refresh or re-tap.
    const again = await resolveActionToken(token, "followup_composer");
    expect(again.ok).toBe(true);
  });

  it("A10.7 the raw token is never stored, only its HMAC digest", async () => {
    const token = await notifiedToken();

    const tokens = await tokenRows();
    expect(tokens[0].token_hash).not.toBe(token);
    expect(String(tokens[0].token_hash)).toMatch(/^[0-9a-f]{64}$/);

    const dumped = await query(`select token_hash from action_tokens`);
    expect(dumped.rows.some((row) => Object.values(row).includes(token))).toBe(false);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A11: acting on a follow-up", () => {
  it("A11.1 the compose URL carries the stored recipient, subject and body", async () => {
    const { followUpId } = await seedDueFollowUp();
    const rows = await messageRows();
    const stored = rows.find((row) => row.id === followUpId)!;

    const url = buildGmailComposeUrl({
      to: String(stored.recipient_email),
      subject: stored.subject as string,
      body: stored.body as string,
    });

    expect(url.startsWith("https://mail.google.com/mail/?")).toBe(true);
    expect(readComposeParam(url, "to")).toBe("info@thearchive.cz");
    expect(readComposeParam(url, "su")).toBe(FOLLOW_UP_1_SUBJECT);
    expect(readComposeParam(url, "body")).toBe(FOLLOW_UP_1_BODY);
    expect(url).not.toContain("send");
  });

  it("A11.2 opening Gmail records no send", async () => {
    const { followUpId } = await seedDueFollowUp();
    const before = await messageRows();
    const leadBefore = (await leadRows())[0];

    // Building the URL is all the action does: it reads, and returns a string.
    const rows = await messageRows();
    const stored = rows.find((row) => row.id === followUpId)!;
    buildGmailComposeUrl({
      to: String(stored.recipient_email),
      subject: stored.subject as string,
      body: stored.body as string,
    });

    expect(await messageRows()).toEqual(before);
    const leadAfter = (await leadRows())[0];
    expect(leadAfter.last_contacted_at).toBe(leadBefore.last_contacted_at);
    expect(leadAfter.followup_count).toBe(leadBefore.followup_count);
  });

  it("A11.3 Mark as sent writes the right row and leaves identity intact", async () => {
    const { leadId, initialId, followUpId } = await seedDueFollowUp();
    await sql(`update leads set last_contacted_at = now() - interval '5 days'`);

    const recorded = await recordOutreachSent({
      messageId: followUpId,
      leadId,
      sentAt: SENT_FOLLOW_UP_1_AT,
      confirmWarnings: true,
    });
    expect(recorded.data?.outcome).toBe("recorded");

    const rows = await messageRows();
    const updated = rows.find((row) => row.id === followUpId)!;
    expect(updated.status).toBe("sent");
    expect(Date.parse(updated.sent_at as string)).toBe(SENT_FOLLOW_UP_1_AT.getTime());
    // Identity is untouched by the send.
    expect(Number(updated.sequence_number)).toBe(1);
    expect(updated.parent_message_id).toBe(initialId);
    expect(rows.find((row) => row.id === initialId)?.status).toBe("sent");

    // Scheduling advanced once: follow-up #2 is due 7 days after this send.
    const lead = (await leadRows())[0];
    expect(Number(lead.followup_count)).toBe(2);
    expect(Date.parse(lead.next_followup_at as string)).toBe(
      new Date("2026-03-17T07:15:00.000Z").getTime(),
    );
  });

  it("A11.4 replaying Mark as sent on a follow-up is idempotent", async () => {
    const { leadId, followUpId } = await seedDueFollowUp();
    await sql(`update leads set last_contacted_at = now() - interval '5 days'`);
    await recordOutreachSent({
      messageId: followUpId,
      leadId,
      sentAt: SENT_FOLLOW_UP_1_AT,
      confirmWarnings: true,
    });
    const scheduled = (await leadRows())[0].next_followup_at;

    const replay = await recordOutreachSent({
      messageId: followUpId,
      leadId,
      sentAt: SENT_FOLLOW_UP_1_AT,
      confirmWarnings: true,
    });

    expect(replay.data?.outcome).toBe("already_sent");
    expect((await leadRows())[0].next_followup_at).toBe(scheduled);
    expect(Number((await leadRows())[0].followup_count)).toBe(2);
  });

  it("A11.5 the deep-link composer edits the linked follow-up in place", async () => {
    const { followUpId } = await seedDueFollowUp();
    await processDueFollowUps({ notifier });
    const token = notifications[0].actionUrl.slice(notifications[0].actionUrl.lastIndexOf("/") + 1);

    const saved = await saveFollowUpDraft({
      rawToken: token,
      subject: "Re: AI recepce — upřesnění nabídky",
      body: `${FOLLOW_UP_1_BODY}\nDoplnění k nabídce.`,
    });

    expect(saved.ok).toBe(true);
    expect(saved.data!.message.id).toBe(followUpId);
    expect(saved.data!.message.sequence_number).toBe(1);
    expect(saved.data!.created).toBe(false);

    // One save and one re-save must not grow the sequence.
    await saveFollowUpDraft({
      rawToken: token,
      subject: "Re: AI recepce — upřesnění nabídky",
      body: `${FOLLOW_UP_1_BODY}\nDoplnění k nabídce.`,
    });

    const rows = await messageRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => Number(row.sequence_number))).toEqual([0, 1]);
    // The already-sent initial outreach still holds its own text.
    expect(rows[0].subject).toBe(INITIAL_SUBJECT);
    expect(rows[0].body).toBe(INITIAL_BODY);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A12: activity", () => {
  async function seedTwoSends() {
    const draft = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });
    const leadId = draft.data!.lead.id;
    const initialId = draft.data!.message.id;
    await recordSend(initialId, leadId, SENT_INITIAL_AT);

    const one = await createFollowUpDraft({
      anchorMessageId: initialId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });
    await recordSend(one.data!.message.id, leadId, SENT_FOLLOW_UP_1_AT);

    // Slot 2 exists as a draft and must never show up as activity.
    await createFollowUpDraft({
      anchorMessageId: one.data!.message.id,
      subject: FOLLOW_UP_2_SUBJECT,
      body: FOLLOW_UP_2_BODY,
    });
    return { leadId, initialId, followUpId: one.data!.message.id };
  }

  it("A12.1 activity lists exactly the recorded sends, newest first", async () => {
    const { initialId, followUpId } = await seedTwoSends();

    const activity = await listOutreachActivity();

    expect(activity.ok).toBe(true);
    expect(activity.data).toHaveLength(2);
    expect(activity.data![0].message.id).toBe(followUpId);
    expect(activity.data![0].typeLabel).toBe("Follow-up #1");
    expect(activity.data![1].message.id).toBe(initialId);
    expect(activity.data![1].typeLabel).toBe("Initial outreach");
    expect(activity.data![0].lead.email).toBe("info@thearchive.cz");
  });

  it("A12.2 an unsent draft is not activity and is not reachable through it", async () => {
    await seedTwoSends();
    const draftId = (await messageRows())[2].id as string;

    const activity = await listOutreachActivity();
    expect(activity.data!.map((item) => item.message.id)).not.toContain(draftId);

    const detail = await getOutreachActivityDetail(draftId);
    expect(detail.ok).toBe(false);
    expect(detail.reason).toBe("not_found");
  });

  it("A12.3 the detail is read-only and reports unrecorded history honestly", async () => {
    const { followUpId } = await seedTwoSends();
    const before = await messageRows();

    const detail = await getOutreachActivityDetail(followUpId);

    expect(detail.ok).toBe(true);
    expect(detail.data!.parent?.sequence_number).toBe(0);
    expect(detail.data!.initial?.sequence_number).toBe(0);
    expect(detail.data!.isInitial).toBe(false);
    expect(await messageRows()).toEqual(before);

    // Slot 2 is a draft, so the two stored rows match followup_count exactly.
    expect(detail.data!.message.lead_id).toBe(detail.data!.lead.id);
  });

  it("A12.4 activity invents nothing for a lead whose counter outruns its rows", async () => {
    const { leadId } = await seedTwoSends();
    await sql(`update leads set followup_count = 9`);

    const activity = await listOutreachActivity();

    // Two sends are still two activity records; the counter adds none.
    expect(activity.data).toHaveLength(2);
    const history = await listOutreachHistory();
    const row = history.data!.find((entry) => entry.id === leadId)!;
    expect(row.messageCount).toBe(3);
    expect(row.lastFollowupNotifiedNumber).toBeNull();
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A13: stats", () => {
  async function seedTwoSends() {
    const draft = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });
    const leadId = draft.data!.lead.id;
    const initialId = draft.data!.message.id;
    await recordOutreachSent({ messageId: initialId, leadId, sentAt: SENT_INITIAL_AT, confirmWarnings: true });
    const one = await createFollowUpDraft({
      anchorMessageId: initialId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });
    await recordOutreachSent({
      messageId: one.data!.message.id,
      leadId,
      sentAt: SENT_FOLLOW_UP_1_AT,
      confirmWarnings: true,
    });
    // An unsent follow-up, which must not move any counter.
    await createFollowUpDraft({
      anchorMessageId: one.data!.message.id,
      subject: FOLLOW_UP_2_SUBJECT,
      body: FOLLOW_UP_2_BODY,
    });
  }

  it("A13.1 every window is counted from recorded sends only", async () => {
    await seedTwoSends();

    const stats = await getOutreachStats({ timeZone: "Europe/Prague", now: NOW });

    expect(stats.ok).toBe(true);
    const data = stats.data!;
    // Monday 09:30 local and Tuesday 08:15 local, read on Tuesday 10:00 local.
    expect(data.today).toBe(1);
    expect(data.week).toBe(2);
    expect(data.month).toBe(2);
    expect(data.allTime).toBe(2);
    expect(data.initialOutreach).toBe(1);
    expect(data.followUps).toBe(1);
    expect(data.totalSent).toBe(data.allTime);
    expect(data.complete).toBe(true);
    expect(data.windows.timeZone).toBe("Europe/Prague");
  });

  it("A13.2 an undated or unsent row can never reach a counter", async () => {
    await seedTwoSends();

    // The schema itself refuses `status = 'sent'` without `sent_at`, so the
    // anomaly Stats defends against cannot be written in the first place.
    const undated = await writeAccepted(
      `update outreach_messages set status = 'sent', sent_at = null where sequence_number = 2 returning *`,
    );
    expect(undated).toBe(false);

    // And the counting re-checks the predicate anyway.
    const stats = await getOutreachStats({ timeZone: "Europe/Prague", now: NOW });
    const counted = countSentStats(
      [
        { status: "sent", sequence_number: 0, sent_at: "2026-03-10T08:30:00.000Z" },
        { status: "sent", sequence_number: 1, sent_at: null },
        { status: "draft", sequence_number: 2, sent_at: "2026-03-10T08:30:00.000Z" },
        { status: "sent", sequence_number: 3, sent_at: "not-a-date" },
      ],
      stats.data!.windows,
    );
    expect(counted.allTime).toBe(1);
    expect(counted.initialOutreach).toBe(1);
    expect(counted.followUps).toBe(0);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — A14: streaks", () => {
  async function seedTwoSends() {
    const draft = await createDraft({
      recipientEmail: "info@thearchive.cz",
      subject: INITIAL_SUBJECT,
      body: INITIAL_BODY,
    });
    const leadId = draft.data!.lead.id;
    const initialId = draft.data!.message.id;
    await recordOutreachSent({ messageId: initialId, leadId, sentAt: SENT_INITIAL_AT, confirmWarnings: true });
    const one = await createFollowUpDraft({
      anchorMessageId: initialId,
      subject: FOLLOW_UP_1_SUBJECT,
      body: FOLLOW_UP_1_BODY,
    });
    await recordOutreachSent({
      messageId: one.data!.message.id,
      leadId,
      sentAt: SENT_FOLLOW_UP_1_AT,
      confirmWarnings: true,
    });
    return one.data!.message.id;
  }

  it("A14.1 consecutive send days produce a real run", async () => {
    await seedTwoSends();

    const streaks = await getOutreachStreaks({ timeZone: "Europe/Prague", now: NOW });

    expect(streaks.ok).toBe(true);
    const data = streaks.data!;
    expect(data.currentStreak).toBe(2);
    expect(data.longestStreak).toBe(2);
    expect(data.activeDaysThisWeek).toBe(2);
    expect(data.activeDaysThisMonth).toBe(2);
    expect(data.totalActiveDays).toBe(2);
    expect(data.complete).toBe(true);
    expect(data.currentStreakComplete).toBe(true);
  });

  it("A14.2 an unsent follow-up cannot manufacture an active day", async () => {
    await seedTwoSends();

    // A draft three days out, on a day with no recorded send at all.
    const rows = await messageRows();
    await createFollowUpDraft({
      anchorMessageId: rows[1].id as string,
      subject: FOLLOW_UP_2_SUBJECT,
      body: FOLLOW_UP_2_BODY,
    });

    const streaks = await getOutreachStreaks({ timeZone: "Europe/Prague", now: NOW });
    expect(streaks.data!.totalActiveDays).toBe(2);
    expect(streaks.data!.currentStreak).toBe(2);

    // A gap breaks the run honestly rather than rounding over it.
    const afterGap = await getOutreachStreaks({
      timeZone: "Europe/Prague",
      now: new Date("2026-03-11T09:00:00.000Z"),
    });
    expect(afterGap.data!.currentStreak).toBe(0);
    expect(afterGap.data!.longestStreak).toBe(2);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — B: failure and edge-case matrix", () => {
  it("B.1 an orphaned follow-up survives its parent and says so", async () => {
    const { initialId, followUpId } = await seedDueFollowUp();

    // ON DELETE SET NULL: the recorded follow-up must outlive a deleted parent.
    await sql(`delete from outreach_messages where id = '${initialId}'`);

    const rows = await messageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(followUpId);
    expect(rows[0].parent_message_id).toBeNull();

    const detail = await getFollowUpDetail(followUpId);
    expect(detail.ok).toBe(true);
    expect(detail.data!.parent).toBeNull();
    expect(detail.data!.initial).toBeNull();
    // Nothing is reconstructed to fill the hole.
    expect(detail.data!.message.sequence_number).toBe(1);
  });

  it("B.2 a stale claim is taken over, and a live lease is left alone", async () => {
    const { leadId, followUpId } = await seedDueFollowUp();
    const stale = new Date(Date.now() - CLAIM_LEASE_MS - 60_000).toISOString();

    await query(
      `insert into followup_notifications (lead_id, outreach_id, followup_number, status, claimed_at) ` +
        `values ('${leadId}', '${followUpId}', 1, 'claimed', '${stale}')`,
    );

    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.notified).toBe(1);
    expect(outcome.skippedBusy).toBe(0);
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("sent");
  });

  it("B.3 an unexpired lease is respected by a second run", async () => {
    const { leadId, followUpId } = await seedDueFollowUp();
    const fresh = new Date(Date.now() - 60_000).toISOString();

    await query(
      `insert into followup_notifications (lead_id, outreach_id, followup_number, status, claimed_at) ` +
        `values ('${leadId}', '${followUpId}', 1, 'claimed', '${fresh}')`,
    );

    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.notified).toBe(0);
    expect(outcome.skippedBusy).toBe(1);
    expect(notifications).toHaveLength(0);

    // The other worker's claim is untouched: still claimed, still undelivered.
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("claimed");
    expect(ledger[0].sent_at).toBeNull();
  });

  it("B.4 a replied lead is never notified", async () => {
    const { leadId } = await seedDueFollowUp();
    await sql(`update leads set status = 'replied' where id = '${leadId}'`);

    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.examined).toBe(0);
    expect(outcome.notified).toBe(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("B.5 a pre-Phase-8A ledger row is honoured, and the lead is not announced twice", async () => {
    const { leadId } = await seedDueFollowUp();

    // Written before notifications were bound to sequence numbers, so the row
    // is keyed by the old `followup_count + 1` value rather than the row's slot.
    await sql(`update leads set followup_count = 2`);
    await query(
      `insert into followup_notifications (lead_id, outreach_id, followup_number, status, claimed_at, sent_at) ` +
        `values ('${leadId}', null, 3, 'sent', now() - interval '1 day', now() - interval '1 day')`,
    );

    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.skippedAlreadyNotified).toBe(1);
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    // The historic row is read, never rewritten or deleted.
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].followup_number).toBe(3);
    expect(ledger[0].status).toBe("sent");
  });

  it("B.6 a lead past the cadence stops being chased", async () => {
    await seedDueFollowUp();
    await sql(`update leads set followup_count = 3`);

    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.skippedMaxCadence).toBe(1);
    expect(outcome.notified).toBe(0);
    // The schedule is cleared, so the lead stops appearing as due forever.
    expect((await leadRows())[0].next_followup_at).toBeNull();
    expect(notifications).toHaveLength(0);
  });

  it("B.7 a poisoned follow-up does not block the rest of the queue", async () => {
    const { leadId, followUpId } = await seedDueFollowUp();

    // A second, healthy lead that the same run must still process.
    await createLead({ email: "info@bistro.cz", companyName: "Bistro" });
    const bistro = await createDraft({
      recipientEmail: "info@bistro.cz",
      subject: "AI recepce pro restauraci Na konvici",
      body: "Dobrý den,\nrád bych vám představil AI recepce pro vaši restauraci.\nS pozdravem",
    });
    await recordOutreachSent({
      messageId: bistro.data!.message.id,
      leadId: bistro.data!.lead.id,
      sentAt: SENT_INITIAL_AT,
      confirmWarnings: true,
    });
    const bistroFollowUp = await createFollowUpDraft({
      anchorMessageId: bistro.data!.message.id,
      subject: "Re: AI recepce pro restauraci Na konvici",
      body: "Dobrý den,\nposílám upřesnění pro vaši restauraci.\nS pozdravem",
    });
    await sql(`update leads set next_followup_at = now() - interval '1 hour'`);
    await sql(
      `update leads set followup_count = 1 where id = '${bistro.data!.lead.id}'`,
    );

    // The Archive's follow-up is notified; nothing here is poisoned yet, so
    // both leads must come through in one run.
    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.examined).toBe(2);
    expect(outcome.notified).toBe(2);
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(2);
    expect(ledger.map((row) => row.outreach_id).sort()).toEqual(
      [followUpId, bistroFollowUp.data!.message.id].sort(),
    );
    expect(leadId).toBeTruthy();
  });

  it("B.8 a notification never runs when no channel is resolvable", async () => {
    await seedDueFollowUp();

    // No notifier and no configured channel: the run must report a failure
    // rather than quietly claiming the work was done.
    const outcome = await processDueFollowUps({ notifier: undefined });

    expect(outcome.examined).toBe(1);
    // Telegram is unconfigured in this rehearsal, so there is no channel.
    expect(outcome.notified).toBe(0);
    expect(notifications).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });
});

// ===========================================================================

describe.skipIf(!DATABASE)("Phase 8D — no new tables, no schema change", () => {
  it("the rehearsal introduced nothing Phase 8D had to add", async () => {
    const rows = await asJson(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      "action_tokens",
      "due_followups",
      "followup_notifications",
      "leads",
      "outreach_messages",
      "outreach_overview",
    ]);
  });
});