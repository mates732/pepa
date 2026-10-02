import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORT_TOKEN_TTL_MS } from "@/lib/deep-link/tokens";

import { createOutreachImport, resolveOutreachImport, saveImportedDraft } from "./import-service";

/**
 * Import-flow tests against an in-memory store that enforces the same unique
 * constraints Postgres does:
 *
 *   unique (lead_id, recipient_normalized)   -> one outreach row per lead+recipient
 *   unique (leads.email_normalized)          -> one lead per normalized email
 *   unique (action_tokens.token_hash)        -> one token per digest
 *
 * plus the purpose check, so a token minted for an import can never resolve as a
 * follow-up token and vice versa.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase } = vi.hoisted(() => {
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

  /**
   * PostgREST resolves `leads(...)` and `outreach_messages(...)` into embedded
   * objects on an action_tokens select. The resolution code depends on them.
   */
  function embed(row: Row | null): Row | null {
    if (!row || !("lead_id" in row)) return row;
    const { lead_id, outreach_id, ...token } = row;
    return {
      ...token,
      leads: db.leads.find((l) => l.id === lead_id) ?? null,
      outreach_messages: db.messages.find((m) => m.id === outreach_id) ?? null,
    };
  }

  function builder(table: Table, filters: Array<[string, unknown]>, head = false) {
    const matched = () =>
      (db[TABLES[table]] as Row[]).filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      );

    const b: Record<string, unknown> = {};
    b.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return b;
    };
    b.in = (column: string, values: unknown[]) => {
      filters.push([column, values]);
      return b;
    };
    b.order = () => b;
    b.limit = () => b;
    b.select = () => b;
    b.maybeSingle = async () => ({ data: embed(matched()[0] ?? null), error: null });
    b.then = async (onFulfilled: (value: unknown) => unknown) =>
      onFulfilled(
        // PostgREST's head+count mode: data is null, count is the row count.
        head ? { data: null, count: matched().length, error: null } : { data: matched().map(embed) },
      );
    return b;
  }

  /** The columns Postgres generates; the app never writes them. */
  function withGenerated(table: Table, row: Row): Row {
    if (table === "leads" && typeof row.email === "string") {
      return { ...row, email_normalized: row.email.trim().toLowerCase() };
    }
    if (table === "outreach_messages" && typeof row.recipient_email === "string") {
      return { ...row, recipient_normalized: row.recipient_email.trim().toLowerCase() };
    }
    return row;
  }

  /** insert/upsert with PostgREST's return=representation chaining. */
  function writeBuilder(
    table: Table,
    rows: Row[],
    mode: "insert" | "upsert",
    onConflict?: string,
  ) {
    const apply = (): Row[] => {
      const stored: Row[] = [];
      if (mode === "upsert" && onConflict) {
        const [left, right] = onConflict.split(",").map((c) => c.trim());
        for (const raw of rows) {
          const row = withGenerated(table, raw);
          const existing = db[TABLES[table]].find(
            (candidate) => candidate[left] === row[left] && candidate[right] === row[right],
          );
          if (existing) {
            Object.assign(existing, row);
            stored.push(existing);
          } else {
            const inserted = { id: `row-${(nextId += 1)}`, ...row };
            db[TABLES[table]].push(inserted);
            stored.push(inserted);
          }
        }
      } else {
        for (const raw of rows) {
          const inserted = { id: `row-${(nextId += 1)}`, ...withGenerated(table, raw) };
          db[TABLES[table]].push(inserted);
          stored.push(inserted);
        }
      }
      return stored;
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
    b.then = async (onFulfilled: (value: unknown) => unknown) =>
      onFulfilled({ data: apply(), error: null });
    return b;
  }

  function makeSupabase() {
    return {
      from(table: Table) {
        return {
          select: (_columns?: string, options?: { head?: boolean }) =>
            builder(table, [], Boolean(options?.head)),
          insert: (payload: Row | Row[]) =>
            writeBuilder(table, Array.isArray(payload) ? payload : [payload], "insert"),
          upsert: (payload: Row | Row[], options?: { onConflict?: string }) =>
            writeBuilder(
              table,
              Array.isArray(payload) ? payload : [payload],
              "upsert",
              options?.onConflict,
            ),
          update(patch: Row) {
            const filters: Array<[string, unknown]> = [];
            const b: Record<string, unknown> = {};
            const apply = () => {
              const rows = (db[TABLES[table]] as Row[]).filter((row) =>
                filters.every(([column, value]) =>
                  Array.isArray(value) ? value.includes(row[column]) : row[column] === value,
                ),
              );
              rows.forEach((row) => Object.assign(row, patch));
              return rows;
            };
            b.eq = (column: string, value: unknown) => {
              filters.push([column, value]);
              return b;
            };
            b.in = (column: string, values: unknown[]) => {
              filters.push([column, values]);
              return b;
            };
            b.select = () => b;
            b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
            b.then = async (onFulfilled: (value: unknown) => unknown) =>
              onFulfilled({ data: apply(), error: null });
            return b;
          },
        };
      },
    };
  }

  return { db, makeSupabase: () => makeSupabase() };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

vi.mock("@/lib/config/base-url", () => ({
  buildImportDeepLink: async (token: string) => `https://pepa.example.com/import/${token}`,
  buildDeepLink: async (token: string) => `https://pepa.example.com/followup/${token}`,
  getBaseUrl: async () => "https://pepa.example.com",
}));

vi.mock("@/lib/deep-link/tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/deep-link/tokens")>();
  return { ...actual, IMPORT_TOKEN_TTL_MS: 30 * 60 * 1000 };
});

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: async () => ({ id: "owner", since: 0 }),
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/auth/env", () => ({
  sessionSecret: () => "test-secret-that-is-definitely-longer-than-32-chars",
  assertServerEnv: () => undefined,
}));

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = "test-secret-that-is-definitely-longer-than-32-chars";
  db.leads = [];
  db.messages = [];
  db.tokens = [];
});

const validPayload = {
  recipient: "hello@example.com",
  subject: "Quick idea for Example Business",
  body: "Dobrý den,\n\nposílám krátký návrh.",
};

function seedExistingMessage(overrides: Partial<Row> = {}) {
  const leadId = "11111111-1111-1111-1111-111111111111";
  db.leads.push({
    id: leadId,
    email: "hello@example.com",
    email_normalized: "hello@example.com",
    company_name: "Example Business",
    contact_name: null,
    status: "ready",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
  });
  db.messages.push({
    id: "22222222-2222-2222-2222-222222222222",
    lead_id: leadId,
    recipient_email: "hello@example.com",
    recipient_normalized: "hello@example.com",
    subject: "Previous subject",
    body: "Previous body",
    status: "draft",
    provider: null,
    provider_message_id: null,
    sent_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });
  return leadId;
}

describe("createOutreachImport — validation gate", () => {
  it("rejects an invalid recipient without writing anything", async () => {
    const outcome = await createOutreachImport({ ...validPayload, recipient: "nope" });

    expect(outcome.ok).toBe(false);
    expect(db.leads).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
  });

  it("rejects an empty subject and an empty body", async () => {
    expect((await createOutreachImport({ ...validPayload, subject: "" })).ok).toBe(false);
    expect((await createOutreachImport({ ...validPayload, body: "" })).ok).toBe(false);
    expect(db.messages).toHaveLength(0);
  });

  it("rejects an oversized payload", async () => {
    const outcome = await createOutreachImport({ ...validPayload, body: "x".repeat(20_001) });
    expect(outcome.ok).toBe(false);
    expect(db.messages).toHaveLength(0);
  });
});

describe("createOutreachImport — persistence", () => {
  it("stores a draft, never a sent message", async () => {
    const outcome = await createOutreachImport(validPayload);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(db.messages).toHaveLength(1);
    const [message] = db.messages;
    expect(message.status).toBe("draft");
    expect(message.sent_at).toBeNull();
    expect(message.provider).toBeNull();
    expect(message.subject).toBe(validPayload.subject);
    expect(message.body).toBe(validPayload.body);
  });

  it("normalizes the recipient before storing", async () => {
    const outcome = await createOutreachImport({
      ...validPayload,
      recipient: "Jan Novák <Hello@Example.COM>",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.recipient).toBe("hello@example.com");
    expect(db.messages[0].recipient_email).toBe("hello@example.com");
    expect(db.leads[0].email).toBe("hello@example.com");
  });

  it("returns an opaque deep link that contains only a token", async () => {
    const outcome = await createOutreachImport(validPayload);
    if (!outcome.ok) throw new Error("expected success");

    expect(outcome.deepLink).toMatch(/^https:\/\/pepa\.example\.com\/import\/fp1_[A-Za-z0-9_-]+$/);
    // No outreach content anywhere in the link.
    expect(outcome.deepLink).not.toContain("hello");
    expect(outcome.deepLink).not.toContain("Example");
    expect(outcome.deepLink).not.toContain("Dobr");
  });

  it("mints an outreach_import token, never a followup_composer token", async () => {
    await createOutreachImport(validPayload);

    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0].purpose).toBe("outreach_import");
  });

  it("stores only a digest of the token, never the raw value", async () => {
    const outcome = await createOutreachImport(validPayload);
    if (!outcome.ok) throw new Error("expected success");

    const raw = outcome.deepLink.split("/import/")[1];
    expect(db.tokens[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.tokens)).not.toContain(raw);
    expect(db.tokens[0].token_hash).not.toContain(raw);
  });

  it("gives the token a short expiry", async () => {
    await createOutreachImport(validPayload);

    const expires = Date.parse(String(db.tokens[0].expires_at));
    const delta = expires - Date.now();
    expect(delta).toBeGreaterThan(IMPORT_TOKEN_TTL_MS - 60_000);
    expect(delta).toBeLessThanOrEqual(IMPORT_TOKEN_TTL_MS);
  });

  it("does not expose database ids to the caller", async () => {
    const outcome = await createOutreachImport(validPayload);
    if (!outcome.ok) throw new Error("expected success");

    const leadId = String(db.leads[0].id);
    const messageId = String(db.messages[0].id);
    expect(outcome).not.toHaveProperty("leadId");
    expect(outcome).not.toHaveProperty("messageId");
    expect(JSON.stringify(outcome)).not.toContain(leadId);
    expect(JSON.stringify(outcome)).not.toContain(messageId);
  });
});

describe("createOutreachImport — dedupe", () => {
  it("refreshes an existing draft instead of creating a second message", async () => {
    seedExistingMessage();

    const outcome = await createOutreachImport({
      ...validPayload,
      subject: "Refreshed subject",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.created).toBe(false);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].subject).toBe("Refreshed subject");
    expect(db.messages[0].status).toBe("draft");
  });

  it("reuses the existing lead rather than creating a duplicate", async () => {
    seedExistingMessage();
    await createOutreachImport(validPayload);

    expect(db.leads).toHaveLength(1);
  });

  it("refuses to overwrite a message that has already been sent", async () => {
    seedExistingMessage({ status: "sent", sent_at: "2026-09-20T09:00:00.000Z" });

    const outcome = await createOutreachImport({ ...validPayload, subject: "Overwrite attempt" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("already_contacted");
    expect(outcome.error).toMatch(/already contacted/i);

    expect(db.messages[0].subject).toBe("Previous subject");
    expect(db.tokens).toHaveLength(0);
  });

  it.each(["follow_up", "replied", "completed", "blocked"])(
    "refuses to overwrite a %s message",
    async (status) => {
      seedExistingMessage({ status, sent_at: "2026-09-20T09:00:00.000Z" });

      const outcome = await createOutreachImport(validPayload);
      expect(outcome.ok).toBe(false);
      expect(db.messages[0].status).toBe(status);
      expect(db.tokens).toHaveLength(0);
    },
  );

  it("two identical imports produce one message and one new token each", async () => {
    await createOutreachImport(validPayload);
    await createOutreachImport(validPayload);

    expect(db.messages).toHaveLength(1);
    expect(db.leads).toHaveLength(1);
    // Each import gets its own short-lived link; neither duplicates the message.
    expect(db.tokens).toHaveLength(2);
    expect(new Set(db.tokens.map((t) => t.token_hash)).size).toBe(2);
  });
});

describe("resolveOutreachImport — token security", () => {
  async function importAndGetToken() {
    const outcome = await createOutreachImport(validPayload);
    if (!outcome.ok) throw new Error("expected success");
    return outcome.deepLink.split("/import/")[1];
  }

  it("resolves a valid token to its draft and lead", async () => {
    const raw = await importAndGetToken();
    const resolved = await resolveOutreachImport(raw);

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.data.message.recipient_email).toBe("hello@example.com");
    expect(resolved.data.message.subject).toBe(validPayload.subject);
    expect(resolved.data.message.status).toBe("draft");
    expect(resolved.data.imported).toBe(true);
    expect(resolved.data.expiresAt).toBeTruthy();
  });

  it("rejects a malformed token", async () => {
    for (const bad of ["", "not-a-token", "fp1_short", "fp1_" + "A".repeat(43), null, undefined]) {
      const resolved = await resolveOutreachImport(bad);
      expect(resolved.ok).toBe(false);
    }
  });

  it("rejects an unknown but well-formed token", async () => {
    const resolved = await resolveOutreachImport(`fp1_${"A".repeat(43)}`);
    expect(resolved.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const raw = await importAndGetToken();
    db.tokens[0].expires_at = new Date(Date.now() - 1000).toISOString();

    const resolved = await resolveOutreachImport(raw);
    expect(resolved.ok).toBe(false);
  });

  it("rejects a token minted for the follow-up purpose", async () => {
    const raw = await importAndGetToken();
    db.tokens[0].purpose = "followup_composer";

    const resolved = await resolveOutreachImport(raw);
    expect(resolved.ok).toBe(false);
  });

  it("gives the same error for every failure mode", async () => {
    const raw = await importAndGetToken();

    const malformed = await resolveOutreachImport("garbage");
    const unknown = await resolveOutreachImport(`fp1_${"A".repeat(43)}`);

    db.tokens[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const expired = await resolveOutreachImport(raw);

    expect(malformed).toEqual(unknown);
    expect(expired).toEqual(unknown);
  });

  it("rejects a tampered token even when most of it is valid", async () => {
    const raw = await importAndGetToken();
    const tampered = `${raw.slice(0, -1)}${raw.at(-1) === "A" ? "B" : "A"}`;

    const resolved = await resolveOutreachImport(tampered);
    expect(resolved.ok).toBe(false);
  });

  it("does not mark the message as used or sent by being resolved", async () => {
    const raw = await importAndGetToken();
    await resolveOutreachImport(raw);

    expect(db.messages[0].status).toBe("draft");
    expect(db.messages[0].sent_at).toBeNull();
  });
});

describe("saveImportedDraft", () => {
  async function importAndGetToken() {
    const outcome = await createOutreachImport(validPayload);
    if (!outcome.ok) throw new Error("expected success");
    return outcome.deepLink.split("/import/")[1];
  }

  it("saves edits against the draft", async () => {
    const raw = await importAndGetToken();
    const result = await saveImportedDraft({ rawToken: raw, subject: "Edited", body: "Edited body" });

    expect(result.ok).toBe(true);
    expect(db.messages[0].subject).toBe("Edited");
    expect(db.messages[0].body).toBe("Edited body");
    expect(db.messages[0].status).toBe("draft");
  });

  it("rejects an empty subject or body", async () => {
    const raw = await importAndGetToken();

    expect((await saveImportedDraft({ rawToken: raw, subject: "  ", body: "x" })).ok).toBe(false);
    expect((await saveImportedDraft({ rawToken: raw, subject: "x", body: "  " })).ok).toBe(false);
  });

  it("rejects an oversized edit", async () => {
    const raw = await importAndGetToken();
    const result = await saveImportedDraft({
      rawToken: raw,
      subject: "x",
      body: "y".repeat(20_001),
    });

    expect(result.ok).toBe(false);
    expect(db.messages[0].body).toBe(validPayload.body);
  });

  it("refuses to edit a message that has already been sent", async () => {
    const raw = await importAndGetToken();
    db.messages[0].status = "sent";
    db.messages[0].sent_at = new Date().toISOString();

    const result = await saveImportedDraft({ rawToken: raw, subject: "Rewritten", body: "Rewritten" });

    expect(result.ok).toBe(false);
    expect(db.messages[0].subject).toBe(validPayload.subject);
  });

  it("rejects an invalid token without touching any message", async () => {
    await importAndGetToken();
    const result = await saveImportedDraft({
      rawToken: `fp1_${"A".repeat(43)}`,
      subject: "Rewritten",
      body: "Rewritten",
    });

    expect(result.ok).toBe(false);
    expect(db.messages[0].subject).toBe(validPayload.subject);
  });

  it("cannot edit a message belonging to a different import token", async () => {
    await importAndGetToken();
    const outcomeB = await createOutreachImport({
      ...validPayload,
      recipient: "second@example.com",
    });
    if (!outcomeB.ok) throw new Error("expected success");
    const rawB = outcomeB.deepLink.split("/import/")[1];

    await saveImportedDraft({ rawToken: rawB, subject: "B subject", body: "B body" });

    expect(db.messages.find((m) => m.recipient_email === "hello@example.com")?.subject).toBe(
      validPayload.subject,
    );
    expect(db.messages.find((m) => m.recipient_email === "second@example.com")?.subject).toBe(
      "B subject",
    );
  });
});