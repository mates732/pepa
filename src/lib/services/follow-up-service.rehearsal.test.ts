import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { processDueFollowUps, type ActionNotifier } from "./follow-up-service";

/**
 * Phase 8A rehearsal against a real PostgreSQL database.
 *
 * The in-memory suite in `follow-up-service.test.ts` re-implements the unique
 * constraint so idempotency can be exercised quickly. This file exists to check
 * the same claims against the actual schema: the real `due_followups` view, the
 * real `unique (lead_id, followup_number)` constraint, and the real
 * `claimed`/`sent` state machine — including two processors racing.
 *
 * It is skipped unless `PEPA_REHEARSAL_DB` names a database that already has the
 * migrations applied, so `npm test` never depends on a local server:
 *
 *   psql -d postgres -c 'create database pepa_rehearsal'
 *   for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 \
 *     -d pepa_rehearsal -f "$f"; done
 *   PEPA_REHEARSAL_DB=pepa_rehearsal npx vitest run \
 *     src/lib/services/follow-up-service.rehearsal.test.ts
 *
 * Talks to the server through `psql`, which keeps the rehearsal free of any new
 * dependency. Every call is a real round trip on its own connection, so two
 * concurrent processors genuinely race inside Postgres rather than inside this
 * process.
 */

const DATABASE = process.env.PEPA_REHEARSAL_DB;

vi.mock("server-only", () => ({}));

vi.mock("@/lib/config/base-url", () => ({
  buildDeepLink: async (token: string) => `https://pepa.example.com/followup/${token}`,
  getBaseUrl: async () => "https://pepa.example.com",
}));

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Minimal Postgres client: just the query-builder surface this service uses.
// ---------------------------------------------------------------------------

const run = promisify(execFile);

/** Postgres reports the violated constraint; the ledger's is the one that matters. */
const UNIQUE_CONSTRAINT = "followup_notifications_unique";
const SEQUENCE_CONSTRAINT = "outreach_messages_sequence_key";

function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return name;
}

type Filter = { column: string; op: "eq" | "in" | "is" | "gt"; value: unknown };

function whereClause(filters: Filter[]): string {
  const parts = filters.map(({ column, op, value }) => {
    const col = identifier(column);
    if (op === "in") return `${col} in (${(value as unknown[]).map(literal).join(", ")})`;
    if (op === "gt") return `${col} > ${literal(value)}`;
    if (op === "is" && value === null) return `${col} is null`;
    return `${col} = ${literal(value)}`;
  });
  return parts.length ? `where ${parts.join(" and ")}` : "";
}

async function query(sql: string): Promise<{ rows: Row[]; error: { code: string; message: string } | null }> {
  try {
    const { stdout } = await run("psql", ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-d", DATABASE as string, "-c", sql], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (!text) return { rows: [], error: null };
    if (text.startsWith("[")) return { rows: JSON.parse(text) as Row[], error: null };
    // `select count(*)` returns a bare number.
    if (/^\d+$/.test(text)) return { rows: [{ count: Number(text) }], error: null };
    return { rows: [], error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes(UNIQUE_CONSTRAINT) || message.includes(SEQUENCE_CONSTRAINT) ? "23505" : "P0001";
    return { rows: [], error: { code, message: message.split("\n")[0] } };
  }
}

interface Builder {
  select: (columns?: string, options?: { head?: boolean }) => Builder;
  insert: (payload: Row | Row[]) => Builder;
  update: (payload: Row) => Builder;
  delete: () => Builder;
  eq: (column: string, value: unknown) => Builder;
  in: (column: string, values: unknown[]) => Builder;
  is: (column: string, value: unknown) => Builder;
  gt: (column: string, value: unknown) => Builder;
  order: (column: string, options?: { ascending?: boolean }) => Builder;
  limit: (count: number) => Builder;
  maybeSingle: () => Promise<{ data: Row | null; error: { code: string; message: string } | null }>;
  then: <T>(onFulfilled: (value: { data: unknown; error: unknown; count?: number }) => T) => Promise<T>;
}

function builder(table: string): Builder {
  const filters: Filter[] = [];
  let columns: string | null = null;
  let head = false;
  let operation: { kind: "select" } | { kind: "insert"; payload: Row } | { kind: "update"; payload: Row } | { kind: "delete" } = {
    kind: "select",
  };
  let order: { column: string; ascending: boolean } | null = null;
  let limit: number | null = null;

  const projection = () => (columns ? columns.split(",").map((c) => identifier(c.trim())).join(", ") : "*");

  const sql = (): string => {
    const cond = whereClause(filters);
    if (operation.kind === "select") {
      if (head) return `select count(*)::int from ${table} ${cond}`;
      const orderSql = order ? ` order by ${identifier(order.column)} ${order.ascending ? "asc" : "desc"}` : "";
      const limitSql = limit === null ? "" : ` limit ${limit}`;
      return `select coalesce(json_agg(t), '[]'::json) from (select ${projection()} from ${table} ${cond}${orderSql}${limitSql}) t`;
    }
    if (operation.kind === "delete") {
      return `with r as (delete from ${table} ${cond} returning *) select coalesce(json_agg(r), '[]'::json) from r`;
    }
    const keys = Object.keys(operation.payload);
    if (keys.length === 0) throw new Error("Empty write");
    if (operation.kind === "insert") {
      const inserted = operation.payload;
      const values = keys.map((key) => literal(inserted[key]));
      return `with r as (insert into ${table} (${keys.map(identifier).join(", ")}) values (${values.join(", ")}) returning *) select coalesce(json_agg(r), '[]'::json) from r`;
    }
    const patch = operation.payload;
    const assignments = keys.map((key) => `${identifier(key)} = ${literal(patch[key])}`);
    return `with r as (update ${table} set ${assignments.join(", ")} ${cond} returning *) select coalesce(json_agg(r), '[]'::json) from r`;
  };

  const b = {} as Builder;

  b.select = (next, options) => {
    if (next) columns = next;
    if (options?.head) head = true;
    return b;
  };
  b.insert = (payload) => {
    operation = { kind: "insert", payload: Array.isArray(payload) ? (payload[0] as Row) : payload };
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
  b.is = (column, value) => (filters.push({ column, op: "is", value }), b);
  b.gt = (column, value) => (filters.push({ column, op: "gt", value }), b);
  b.order = (column, options) => ((order = { column, ascending: options?.ascending ?? true }), b);
  b.limit = (count) => ((limit = count), b);
  b.maybeSingle = async () => {
    const result = await query(sql());
    return { data: result.rows[0] ?? null, error: result.error };
  };
  // supabase-js resolves a builder to `{ data, error }` — and to `{ count, ... }`
  // for a head/count select — so awaited reads and awaited writes both work.
  b.then = async (onFulfilled) => {
    const result = await query(sql());
    if (head) {
      return onFulfilled({ data: null, count: Number(result.rows[0]?.count ?? 0), error: result.error });
    }
    return onFulfilled({ data: result.rows, error: result.error });
  };

  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => builder(table) }),
}));

// ---------------------------------------------------------------------------
// Fixture + fake transport. No Telegram call is ever made.
// ---------------------------------------------------------------------------

const notifications: Array<{ title: string; body: string; actionUrl: string }> = [];
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

const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const INITIAL_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const FOLLOW_UP_ID = "aaaaaaaa-0000-4000-8000-000000000003";

async function seed() {
  await query(`delete from leads`);
  await query(
    `insert into leads (id, email, company_name, contact_name, status, last_contacted_at, next_followup_at, followup_count)
     values ('${LEAD_ID}', 'info@thearchive.cz', 'The Archive', 'Info', 'follow_up',
             now() - interval '30 days', now() - interval '1 day', 0)`,
  );
  await query(
    `insert into outreach_messages (id, lead_id, recipient_email, subject, body, status, sent_at, created_at, sequence_number, parent_message_id)
     values ('${INITIAL_ID}', '${LEAD_ID}', 'info@thearchive.cz', 'AI recepce', 'Dobrý den,', 'sent',
             now() - interval '30 days', now() - interval '30 days', 0, null)`,
  );
  await query(
    `insert into outreach_messages (id, lead_id, recipient_email, subject, body, status, sent_at, created_at, sequence_number, parent_message_id)
     values ('${FOLLOW_UP_ID}', '${LEAD_ID}', 'info@thearchive.cz', 'Re: AI recepce', 'Navazuji', 'draft',
             null, now() - interval '2 days', 1, '${INITIAL_ID}')`,
  );
}

/** Rows as JSON, so `query()` can read them back without a bespoke parser. */
function asJson(inner: string): string {
  return `select coalesce(json_agg(t), '[]'::json) from (${inner}) t`;
}

async function ledgerRows(): Promise<Row[]> {
  const { rows } = await query(
    asJson(
      `select id, lead_id, outreach_id, followup_number, status, sent_at, action_token_id from followup_notifications order by created_at`,
    ),
  );
  return rows;
}

async function messageRows(): Promise<Row[]> {
  const { rows } = await query(
    asJson(`select id, sequence_number, status, sent_at, subject, body from outreach_messages order by sequence_number`),
  );
  return rows;
}

beforeAll(async () => {
  if (!DATABASE) return;
  // The real `mintFollowUpToken()` hashes the raw token with this secret, and
  // deliberately refuses to run without it. Synthetic, local-only value.
  process.env.PEPA_SESSION_SECRET = "phase8a-rehearsal-secret-that-is-long-enough-32";
  await seed();
});

beforeEach(async () => {
  if (!DATABASE) return;
  notifications.length = 0;
  failNextSend = false;
  await query(`delete from followup_notifications`);
  await query(`delete from action_tokens`);
});

// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE)("Phase 8A rehearsal — real PostgreSQL", () => {
  it("1-6: an unsent, due follow-up #1 notifies exactly once through the fake transport", async () => {
    const outcome = await processDueFollowUps({ notifier });

    expect(outcome.examined).toBe(1);
    expect(outcome.notified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toContain("Follow-up #1");
    expect(notifications[0].body).toContain("The Archive");
    // No send wording, no email content.
    expect(notifications[0].title + notifications[0].body).not.toMatch(/\bsent\b/i);
    expect(notifications[0].body).not.toContain("Navazuji");
    expect(notifications[0].actionUrl).toMatch(/^https:\/\/pepa\.example\.com\/followup\/fp1_/);
  });

  it("7-8: the ledger names the real follow-up row, not the already-sent anchor", async () => {
    await processDueFollowUps({ notifier });

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outreach_id).toBe(FOLLOW_UP_ID);
    expect(rows[0].outreach_id).not.toBe(INITIAL_ID);
    expect(rows[0].followup_number).toBe(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].sent_at).toBeTruthy();
    // The deep-link token is bound to the same message.
    expect(rows[0].action_token_id).toBeTruthy();
    const { rows: tokens } = await query(asJson(`select outreach_id from action_tokens`));
    expect(tokens[0].outreach_id).toBe(FOLLOW_UP_ID);
  });

  it("9-10: running the processor again adds no row and no message", async () => {
    await processDueFollowUps({ notifier });
    const second = await processDueFollowUps({ notifier });

    expect(second.notified).toBe(0);
    expect(second.skippedAlreadyNotified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("11-13: a manually sent follow-up produces no stale alert", async () => {
    await processDueFollowUps({ notifier });

    // The operator sends it by hand, exactly as `recordOutreachSent()` would.
    await query(
      `update outreach_messages set status = 'sent', sent_at = now() where id = '${FOLLOW_UP_ID}'`,
    );
    await query(`update leads set followup_count = 1, next_followup_at = now() + interval '4 days' where id = '${LEAD_ID}'`);

    const again = await processDueFollowUps({ notifier });
    expect(again.notified).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("14-18: a new due follow-up #2 notifies once, twice concurrently, with a distinct deep link", async () => {
    await query(`delete from followup_notifications`);
    await query(`delete from action_tokens`);
    await query(
      `insert into outreach_messages (id, lead_id, recipient_email, subject, body, status, sequence_number, parent_message_id)
       values ('aaaaaaaa-0000-4000-8000-000000000004', '${LEAD_ID}', 'info@thearchive.cz', 'Re: Re: AI recepce', 'Posledni pozvanka', 'draft', 2, '${FOLLOW_UP_ID}')`,
    );
    await query(`update leads set followup_count = 1, next_followup_at = now() - interval '1 hour' where id = '${LEAD_ID}'`);

    // Two processors race on the same follow-up. Exactly one INSERT into
    // followup_notifications can win `unique (lead_id, followup_number)`.
    const [a, b] = await Promise.all([processDueFollowUps({ notifier }), processDueFollowUps({ notifier })]);

    expect(notifications).toHaveLength(1);
    expect(a.notified + b.notified).toBe(1);
    expect(a.skippedBusy + b.skippedBusy + a.skippedAlreadyNotified + b.skippedAlreadyNotified).toBe(1);
    expect(notifications[0].body).toContain("Follow-up #2");

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].followup_number).toBe(2);
    expect(rows[0].outreach_id).toBe("aaaaaaaa-0000-4000-8000-000000000004");

    // No message content was mutated by processing.
    const messages = await messageRows();
    expect(messages.map((m) => m.subject)).toEqual(["AI recepce", "Re: AI recepce", "Re: Re: AI recepce"]);
    expect(messages[1].body).toBe("Navazuji");
    expect(messages[1].status).toBe("sent");
  });

  it("a Telegram failure leaves no delivered row and the next run retries", async () => {
    await query(`delete from followup_notifications`);
    await query(`delete from action_tokens`);
    await query(`update leads set followup_count = 1, next_followup_at = now() - interval '1 hour' where id = '${LEAD_ID}'`);

    failNextSend = true;
    const failed = await processDueFollowUps({ notifier });

    expect(failed.failed).toBe(1);
    expect(failed.notified).toBe(0);
    expect(await ledgerRows()).toHaveLength(0);

    const retry = await processDueFollowUps({ notifier });
    expect(retry.notified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect((await ledgerRows())[0].status).toBe("sent");
  });

  it("an unrecorded follow-up is skipped and never fabricated", async () => {
    await query(`delete from followup_notifications`);
    await query(`delete from outreach_messages where sequence_number > 0`);
    // The counter claims two follow-ups went out; no rows exist for them.
    await query(`update leads set followup_count = 2, next_followup_at = now() - interval '1 hour' where id = '${LEAD_ID}'`);

    const outcome = await processDueFollowUps({ notifier });
    expect(outcome.notified).toBe(0);
    expect(outcome.skippedUnrecorded).toBe(1);
    expect(notifications).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
    // Nothing was invented: still only the initial outreach.
    expect(await messageRows()).toHaveLength(1);
  });

  it("no new tables and no schema changes were introduced", async () => {
    const { rows } = await query(
      asJson(`select table_name from information_schema.tables where table_schema = 'public' order by table_name`),
    );
    // Exactly the objects the migrations create: two tables, the ledger, plus the
    // two pre-existing views. Phase 8A added none of them.
    expect(rows.map((r) => r.table_name)).toEqual([
      "action_tokens",
      "due_followups",
      "followup_notifications",
      "leads",
      "outreach_messages",
      "outreach_overview",
    ]);
  });
});
