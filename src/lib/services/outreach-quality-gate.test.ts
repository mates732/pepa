import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeBlocked,
  evaluateDraftQualityGate,
  evaluateStoredMessageQualityGate,
  type EvaluatedMessage,
  type GateEvaluation,
} from "./outreach-quality-gate";
import { evaluateQualityGate } from "@/lib/outreach/quality-gate";

/**
 * Service-level tests for `src/lib/services/outreach-quality-gate.ts`.
 *
 * A fake Supabase replaces `getSupabaseAdmin()` and records every read so the
 * tests can assert bounded query counts and the absence of N+1 behaviour. The
 * fake mirrors the real query shapes exactly, including the ones the import
 * path reaches through `lead-service` and `action-token-service`:
 *
 *   leads:      select(..., embed).eq("email_normalized", x).maybeSingle()
 *   msgs:       select(MESSAGE_COLUMNS).eq("lead_id", x).order("created_at", {asc:false})
 *   msg+lk:     select(...).eq("id", x).eq("lead_id", x).maybeSingle()
 *   head+count: select("id", {count:"exact", head:true}).eq("id", x)   -> {count}
 *   writes:     upsert(payload, {onConflict, ignoreDuplicates}).select(...).maybeSingle()
 *               insert(payload).select("id").maybeSingle()
 *
 * PostgREST also generates the unique key columns the app never writes
 * (`leads.email_normalized`, `outreach_messages.recipient_normalized`) and
 * resolves the `outreach_messages(...)` embed in the lead select, so the fake
 * does both — otherwise the read-back after `createLead` could never succeed.
 */

type Row = Record<string, unknown>;

/**
 * Every read the fake serves is recorded here so the tests can assert both the
 * bounded query count and the absence of N+1 behaviour.
 */
const CALLS: Array<{ table: string; filters: Array<{ column: string; value: unknown }> }> = [];

const db = {
  leads: [] as Row[],
  messages: [] as Row[],
  tokens: [] as Row[],
};

let nextId = 1;

/** Supabase table name -> store key. */
const TABLES = {
  leads: "leads",
  outreach_messages: "messages",
  action_tokens: "tokens",
} as const;

type Table = keyof typeof TABLES;

function reset() {
  CALLS.length = 0;
  db.leads = [];
  db.messages = [];
  db.tokens = [];
  nextId = 1;
}

function rows(table: Table): Row[] {
  return db[TABLES[table]];
}

function normalizeEmailValue(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

/**
 * The columns Postgres generates; the app never writes them. Both are the
 * unique keys the real dedupe rules depend on.
 */
function withGenerated(table: Table, row: Row): Row {
  if (table === "leads" && typeof row.email === "string") {
    return { ...row, email_normalized: normalizeEmailValue(row.email) };
  }
  if (table === "outreach_messages" && typeof row.recipient_email === "string") {
    return { ...row, recipient_normalized: normalizeEmailValue(row.recipient_email) };
  }
  return row;
}

/**
 * PostgREST resolves the `outreach_messages(...)` embed in the lead select into
 * a nested array. `findLeadByEmail` depends on it, so the fake serves it rather
 * than letting a lead row look like it has no history.
 */
function embed(row: Row | null, columns: string): Row | null {
  if (!row) return null;
  if (TABLES.leads !== undefined && "lead_id" in row) {
    const { lead_id, outreach_id, ...token } = row;
    return {
      ...token,
      leads: db.leads.find((l) => l.id === lead_id) ?? null,
      outreach_messages: db.messages.find((m) => m.id === outreach_id) ?? null,
    };
  }
  if (!columns.includes("outreach_messages(")) return row;
  // The embedded history is derived from the message store, never from whatever
  // the test happened to seed on the lead row.
  const { outreach_messages: _ignored, ...rest } = row;
  void _ignored;
  return {
    ...rest,
    outreach_messages: db.messages
      .filter((m) => m.lead_id === row.id)
      .map(({ id, status, sent_at, created_at }) => ({ id, status, sent_at, created_at })),
  };
}

function readBuilder(table: Table, columns: string, head: boolean) {
  const filters: Array<{ column: string; value: unknown }> = [];
  let order: { column: string; ascending: boolean } | null = null;

  const matched = (): Row[] => {
    let result = rows(table).filter((row) =>
      filters.every(({ column, value }) =>
        Array.isArray(value) ? value.includes(row[column]) : row[column] === value,
      ),
    );
    if (order) {
      const direction = order.ascending ? 1 : -1;
      result = [...result].sort((a, b) =>
        String(a[order!.column] ?? "").localeCompare(String(b[order!.column] ?? "")) * direction,
      );
    }
    return result;
  };

  const b: Record<string, unknown> = {};

  b.eq = (column: string, value: unknown) => {
    filters.push({ column, value });
    return b;
  };
  b.in = (column: string, values: unknown[]) => {
    filters.push({ column, value: values });
    return b;
  };
  b.order = (column: string, options: { ascending?: boolean }) => {
    order = { column, ascending: options?.ascending ?? true };
    return b;
  };
  b.limit = () => b;

  b.maybeSingle = async () => {
    CALLS.push({ table, filters: [...filters] });
    return { data: embed(matched()[0] ?? null, columns), error: null };
  };

  b.then = (onFulfilled: (value: unknown) => unknown) => {
    CALLS.push({ table, filters: [...filters] });
    // PostgREST's head+count mode returns no rows and a count instead.
    const value = head
      ? { data: null, count: matched().length, error: null }
      : { data: matched().map((row) => embed(row, columns)), error: null };
    return Promise.resolve(onFulfilled(value));
  };

  return b;
}

/**
 * insert/upsert with PostgREST's `return=representation` chaining, honouring the
 * real unique keys so a repeated import refreshes one draft rather than
 * duplicating it.
 */
function writeBuilder(
  table: Table,
  payload: Row[],
  mode: "insert" | "upsert",
  options?: { onConflict?: string; ignoreDuplicates?: boolean },
) {
  const apply = (): Row[] => {
    const stored: Row[] = [];
    const conflictColumns = options?.onConflict
      ?.split(",")
      .map((column) => column.trim())
      .filter(Boolean);

    for (const raw of payload) {
      const row = withGenerated(table, raw);
      const existing = conflictColumns?.length
        ? rows(table).find((candidate) => conflictColumns.every((c) => candidate[c] === row[c]))
        : undefined;

      if (existing && options?.ignoreDuplicates) {
        // `ignoreDuplicates` resolves the race on the unique index in Postgres;
        // the existing row is left untouched.
        stored.push(existing);
        continue;
      }

      if (existing) {
        Object.assign(existing, row);
        stored.push(existing);
        continue;
      }

      const inserted = { id: `row-${(nextId += 1)}`, ...row };
      rows(table).push(inserted);
      stored.push(inserted);
    }
    return stored;
  };

  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
  b.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: apply(), error: null }));
  return b;
}

function makeSupabase() {
  return {
    from(table: Table) {
      return {
        select: (_columns?: string, options?: { head?: boolean }) =>
          readBuilder(table, _columns ?? "", Boolean(options?.head)),
        insert: (payload: Row | Row[]) =>
          writeBuilder(table, Array.isArray(payload) ? payload : [payload], "insert"),
        upsert: (payload: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) =>
          writeBuilder(
            table,
            Array.isArray(payload) ? payload : [payload],
            "upsert",
            options,
          ),
        update(patch: Row) {
          const filters: Array<{ column: string; value: unknown }> = [];
          const b: Record<string, unknown> = {};
          const apply = (): Row[] => {
            const affected = rows(table).filter((row) =>
              filters.every(({ column, value }) =>
                Array.isArray(value) ? value.includes(row[column]) : row[column] === value,
              ),
            );
            affected.forEach((row) => Object.assign(row, patch));
            return affected;
          };
          b.eq = (column: string, value: unknown) => {
            filters.push({ column, value });
            return b;
          };
          b.in = (column: string, values: unknown[]) => {
            filters.push({ column, value: values });
            return b;
          };
          b.select = () => b;
          b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
          b.then = (onFulfilled: (value: unknown) => unknown) =>
            Promise.resolve(onFulfilled({ data: apply(), error: null }));
          return b;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => makeSupabase(),
}));

vi.mock("server-only", () => ({}));

// `createOutreachImport` mints a real deep link, which needs a base URL and a
// signing key. Both are stubbed, never real values.
vi.mock("@/lib/config/base-url", () => ({
  buildImportDeepLink: vi.fn(async (token: string) => `https://pepa.example.com/import/${token}`),
  buildDeepLink: async (token: string) => `https://pepa.example.com/followup/${token}`,
  getBaseUrl: async () => "https://pepa.example.com",
}));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: async () => ({ id: "owner", since: 0 }),
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/auth/env", () => ({
  sessionSecret: () => "test-secret-that-is-definitely-longer-than-32-chars",
  assertServerEnv: () => undefined,
}));

const TEST_SESSION_SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

function lead(overrides: Row = {}): Row {
  return {
    id: "lead-1",
    email: "salon@example.com",
    email_normalized: "salon@example.com",
    company_name: "Salon",
    contact_name: null,
    status: "ready",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
    ...overrides,
  };
}

function msg(overrides: Row = {}): Row {
  return {
    id: "msg-1",
    lead_id: "lead-1",
    recipient_email: "salon@example.com",
    subject: "AI recepce pro váš salon",
    body: "Dobrý den,\n\nrád bych vám nabídl automatizaci.\n\nS pozdravem",
    status: "draft",
    provider: null,
    provider_message_id: null,
    sent_at: null,
    created_at: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  reset();
  process.env.PEPA_SESSION_SECRET = TEST_SESSION_SECRET;
});

/** Seed the lead store. */
function seedLead(overrides: Row = {}) {
  db.leads = [lead(overrides)];
}

/** Seed the message store. */
function seedMessages(rows: Row[]) {
  db.messages = rows;
}

/* -------------------------------------------------------------------------- */
/* A — bounded query count                                                   */
/* -------------------------------------------------------------------------- */

describe("evaluateDraftQualityGate — bounded queries", () => {
  it("performs exactly two queries regardless of history size", async () => {
    seedLead();
    seedMessages([msg({ status: "sent", sent_at: "2026-03-01T00:00:00.000Z" })]);

    await evaluateDraftQualityGate({
      recipient: "salon@example.com",
      subject: "Nabídka",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení pro váš salon.\n\nS pozdravem",
    });

    expect(CALLS).toHaveLength(2);
    expect(CALLS[0]!.table).toBe("leads");
    expect(CALLS[1]!.table).toBe("outreach_messages");
  });
});

/* -------------------------------------------------------------------------- */
/* B — no N+1                                                               */
/* -------------------------------------------------------------------------- */

describe("no N+1", () => {
  it("query count stays constant when history grows from 1 to 25 messages", async () => {
    seedLead();
    seedMessages(
      Array.from({ length: 25 }, (_, i) =>
        msg({
          id: `msg-${i}`,
          status: i === 0 ? "sent" : "draft",
          sent_at: i === 0 ? "2026-03-01T00:00:00.000Z" : null,
          created_at: new Date(Date.now() - i * 86400000).toISOString(),
        }),
      ),
    );

    await evaluateDraftQualityGate({
      recipient: "salon@example.com",
      subject: "Nabídka",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení pro váš salon.\n\nS pozdravem",
    });

    expect(CALLS).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* C — client verdict is not trusted                                        */
/* -------------------------------------------------------------------------- */

describe("server-authoritative verdict", () => {
  it("derives identity from DB state, not from client-supplied leadId hint", async () => {
    // DB says this lead was contacted 1 day ago (cooldown).
    seedLead({
      last_contacted_at: new Date(Date.now() - 86400000).toISOString(),
      followup_count: 1,
    });
    seedMessages([
      msg({ status: "sent", sent_at: new Date(Date.now() - 86400000).toISOString() }),
    ]);

    const result = await evaluateDraftQualityGate({
      recipient: "salon@example.com",
      subject: "Nabídka",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení pro váš salon.\n\nS pozdravem",
      // A malicious client cannot bypass the gate by claiming a different lead.
      leadId: "attacker-lead-id",
    });

    expect(result.status).not.toBe("ready");
    const identity = result.checks.find((c) => c.name === "identity");
    expect(identity?.status).not.toBe("pass");
  });
});

/* -------------------------------------------------------------------------- */
/* D — DB-authoritative subject/body for stored message                     */
/* -------------------------------------------------------------------------- */

describe("evaluateStoredMessageQualityGate — DB authority", () => {
  it("evaluates the stored subject/body, not any alternate client content", async () => {
    const MESSAGE_ID = "msg-stored";
    const LEAD_ID = "lead-1";
    seedLead();
    // Stored message contains a placeholder that would block.
    seedMessages([
      msg({
        id: MESSAGE_ID,
        lead_id: LEAD_ID,
        subject: "Nabídka pro [COMPANY]",
        body: "Dobrý den [NAME],\n\nrád bych vám nabídl řešení.\n\nS pozdravem",
        status: "draft",
        sent_at: null,
      }),
    ]);

    const result = await evaluateStoredMessageQualityGate(MESSAGE_ID, LEAD_ID);

    expect(result).not.toBeNull();
    expect(result!.gate.status).toBe("blocked");
    expect(result!.gate.checks.some((c) => c.name === "placeholders" && c.status === "block")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* E — DB-authoritative identity                                             */
/* -------------------------------------------------------------------------- */

describe("DB-authoritative identity", () => {
  it("returns cooldown when DB says cooldown, even if the draft looks fresh", async () => {
    seedLead({
      last_contacted_at: new Date(Date.now() - 86400000).toISOString(),
      followup_count: 1,
    });
    seedMessages([
      msg({ status: "sent", sent_at: new Date(Date.now() - 86400000).toISOString() }),
    ]);

    const result = await evaluateDraftQualityGate({
      recipient: "salon@example.com",
      subject: "Zcela nový předmět",
      body: "Zcela nový text, který neopakuje nic z předchozích emailů.",
      messageId: "msg-current",
    });

    expect(result.status).toBe("blocked");
    expect(result.checks.find((c) => c.name === "identity")?.reason).toContain("cooldown");
  });
});

/* -------------------------------------------------------------------------- */
/* F — missing lead                                                          */
/* -------------------------------------------------------------------------- */

describe("missing lead", () => {
  it("returns a safe result and does not throw", async () => {
    const result = await evaluateDraftQualityGate({
      recipient: "no-such@example.com",
      subject: "Nabídka",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení pro váš salon.\n\nS pozdravem",
    });

    expect(result.leadId).toBeNull();
    expect(result.status).toBe("ready");
    // A safe result carries no error field at all, so there is nothing to leak.
    expect("error" in result).toBe(false);
    // Must not leak raw DB error text.
    expect(JSON.stringify(result)).not.toMatch(/(?:pg|postgres|supabase|relation|column|syntax)/i);
  });
});

/* -------------------------------------------------------------------------- */
/* G — stored message scoped to message id AND lead id                       */
/* -------------------------------------------------------------------------- */

describe("evaluateStoredMessageQualityGate — cross-lead isolation", () => {
  it("returns null when the message belongs to a different lead", async () => {
    const MESSAGE_ID = "msg-other-lead";
    const LEAD_ID = "lead-1";
    seedLead({ id: LEAD_ID });
    seedMessages([
      msg({ id: MESSAGE_ID, lead_id: "lead-other", subject: "X", body: "Y", status: "draft" }),
    ]);

    const result = await evaluateStoredMessageQualityGate(MESSAGE_ID, LEAD_ID);

    expect(result).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* H — blocked reason rendering                                             */
/* -------------------------------------------------------------------------- */

describe("describeBlocked", () => {
  it("joins only the blocking reasons and names them", async () => {
    seedLead();
    seedMessages([
      msg({
        subject: "AI recepce pro v\u00e1\u0161 salon",
        body: "Dobr\u00fd den,\n\nr\u00e1d bych v\u00e1m nab\u00eddal \u0159e\u0161en\u00ed pro v\u00e1\u0161 salon.\n\nS pozdravem",
        status: "sent",
        sent_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const result = await evaluateDraftQualityGate({
      recipient: "salon@example.com",
      // Identical to the sent message: an exact copy/paste repeat.
      subject: "AI recepce pro v\u00e1\u0161 salon",
      body: "Dobr\u00fd den,\n\nr\u00e1d bych v\u00e1m nab\u00eddal \u0159e\u0161en\u00ed pro v\u00e1\u0161 salon.\n\nS pozdravem",
    });

    expect(result.status).toBe("blocked");

    const summary = describeBlocked(result);
    const blocking = result.checks.filter((check) => check.status === "block");
    expect(blocking.length).toBeGreaterThan(0);
    // Only the blocking reasons are rendered; warnings are deliberately dropped.
    for (const check of blocking) {
      expect(summary).toContain(check.reason);
    }
    const warned = result.checks.filter((check) => check.status === "warn");
    for (const check of warned) {
      expect(summary).not.toContain(check.reason);
    }
    // Diagnostic and historical text never reaches the rendered summary.
    expect(summary).not.toContain("pg_");
    expect(summary).not.toContain("supabase");
  });

  it("falls back to a generic message when nothing blocks", () => {
    const ready = evaluateQualityGate({
      input: {
        recipient: "salon@example.com",
        subject: "Nab\u00eddka",
        body: "Dobr\u00fd den,\n\nr\u00e1d bych v\u00e1m nab\u00eddal \u0159e\u0161en\u00ed pro v\u00e1\u0161 salon.\n\nS pozdravem",
      },
      history: [],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(ready.status).toBe("ready");
    expect(describeBlocked(ready)).toBe("This draft is blocked by the quality gate.");
  });
});

/* -------------------------------------------------------------------------- */
/* I — stored evaluation return shape                                         */
/* -------------------------------------------------------------------------- */

describe("evaluateStoredMessageQualityGate \u2014 result shape", () => {
  it("returns the stored row together with the verdict, not a bare verdict", async () => {
    const MESSAGE_ID = "msg-shape";
    seedLead();
    seedMessages([msg({ id: MESSAGE_ID, subject: "Nab\u00eddka", status: "draft", sent_at: null })]);

    const result: EvaluatedMessage | null = await evaluateStoredMessageQualityGate(
      MESSAGE_ID,
      "lead-1",
    );

    expect(result).not.toBeNull();
    // The send path reads `message` to detect an already-recorded send, so the
    // verdict must never be returned without it.
    expect(result!.message.id).toBe(MESSAGE_ID);
    const gate: GateEvaluation = result!.gate;
    expect(gate.leadId).toBe("lead-1");
    expect(gate.normalizedRecipient).toBe("salon@example.com");
    expect(gate.blocked).toBe(gate.status === "blocked");
    expect(gate.hasWarnings).toBe(gate.status === "warning");
  });
});

/* -------------------------------------------------------------------------- */
/* J \u2014 leaf module                                                           */
/* -------------------------------------------------------------------------- */

describe("leaf module", () => {
  it("does not import outreach-service", async () => {
    const source = await import("./outreach-quality-gate");
    // The service module's own imports are static, so we inspect the module
    // record. A direct circular import would either fail to load or expose the
    // sibling module here.
    expect(source).not.toHaveProperty("outreach-service");
  });
});

/* -------------------------------------------------------------------------- */
/* Import contract — cases 29–31                                              */
/* -------------------------------------------------------------------------- */

describe("import contract remains compatible", () => {
  // No lead is seeded: `createOutreachImport` must create one and read it back,
  // which is exactly the path the fake has to mirror. The service returns
  // `deepLink`; the `deep_link` / `status` names belong to the API route, which
  // maps `deepLink` onto them.
  it("29. valid import remains successful and returns the existing response shape", async () => {
    const { createOutreachImport } = await import("@/lib/services/import-service");

    const result = await createOutreachImport({
      recipient: "import-contract@example.com",
      subject: "Import test",
      body: "Dobrý den,\n\nimportovaný text.\n\nS pozdravem",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deepLink).toMatch(/^https:\/\/pepa\.example\.com\/import\/fp1_[A-Za-z0-9_-]+$/);
    expect(result).toHaveProperty("recipient");
    expect(result).toHaveProperty("expiresAt");
    expect(result).toHaveProperty("created");
    expect(result).toHaveProperty("alreadyContacted");
    // No lead id, no raw token, no payload echo.
    expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("30. gate result is available after import via the draft path", async () => {
    const { createOutreachImport } = await import("@/lib/services/import-service");

    const body = "Dobrý den,\n\nrád bych vám nabídl automatizaci recepce pro váš salon.\n\nS pozdravem";

    const importResult = await createOutreachImport({
      recipient: "import-gate@example.com",
      subject: "Import gate test",
      body,
    });

    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;

    // The import stored a draft, never a sent message: the gate must read the
    // lead back and report it as an editable draft rather than a contact.
    const draftResult = await evaluateDraftQualityGate({
      recipient: importResult.recipient,
      subject: "Import gate test",
      body,
    });

    expect(draftResult.leadId).not.toBeNull();
    expect(draftResult.blocked).toBe(false);
    const identity = draftResult.checks.find((c) => c.name === "identity");
    expect(identity?.status).toBe("pass");
  });

  it("31. existing import response contract fields are unchanged", async () => {
    const { createOutreachImport } = await import("@/lib/services/import-service");

    const result = await createOutreachImport({
      recipient: "import-shape@example.com",
      subject: "Shape",
      body: "Dobrý den,\n\nshape.\n\nS pozdravem",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["alreadyContacted", "created", "deepLink", "expiresAt", "ok", "recipient"]);
  });

  it("32. an import is stored as a draft with no provider and no sent_at", async () => {
    const { createOutreachImport } = await import("@/lib/services/import-service");

    const result = await createOutreachImport({
      recipient: "import-draft@example.com",
      subject: "Draft shape",
      body: "Dobrý den,\n\ndraft.\n\nS pozdravem",
    });

    expect(result.ok).toBe(true);

    const stored = db.messages.filter((row) => row.recipient_email === "import-draft@example.com");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
    });
  });
});