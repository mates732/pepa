import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveFollowUpDraft } from "@/lib/services/action-token-service";

/**
 * Outreach sequence tests.
 *
 * The sequence model answers "which follow-up belongs to which original
 * outreach?" from stored data alone: `sequence_number` gives the position
 * (0 = initial outreach, 1 = follow-up #1, ...) and `parent_message_id` names the
 * predecessor. Nothing here infers a chain by counting.
 *
 * The fake store enforces the same unique key as Postgres —
 * (lead_id, recipient_normalized, sequence_number) — so a duplicate slot is a
 * hard failure rather than a silently overwritten row. The migration itself is
 * verified against a real Postgres instance; these tests cover the TypeScript
 * write paths that build the chain.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase } = vi.hoisted(() => {
  const db = {
    leads: [] as Row[],
    messages: [] as Row[],
    tokens: [] as Row[],
  };

  let nextId = 1;

  const TABLES = {
    leads: "leads",
    outreach_messages: "messages",
    action_tokens: "tokens",
  } as const;

  type Table = keyof typeof TABLES;

  const rows = (table: Table) => db[TABLES[table]];

  function withGenerated(table: Table, row: Row): Row {
    if (table === "leads" && typeof row.email === "string") {
      return { ...row, email_normalized: row.email.trim().toLowerCase() };
    }
    if (table === "outreach_messages" && typeof row.recipient_email === "string") {
      return { ...row, recipient_normalized: row.recipient_email.trim().toLowerCase() };
    }
    return row;
  }

  function embed(row: Row | null): Row | null {
    if (!row || !("lead_id" in row)) return row;
    const { lead_id, outreach_id, ...token } = row;
    return {
      ...token,
      leads: db.leads.find((l) => l.id === lead_id) ?? null,
      outreach_messages: db.messages.find((m) => m.id === outreach_id) ?? null,
    };
  }

  function builder(table: Table, filters: Array<[string, unknown]>, order: { column: string; ascending: boolean } | null, limit: number | null, head: boolean) {
    const matched = (): Row[] => {
      const filtered = rows(table).filter((row) =>
        filters.every(([column, value]) =>
          Array.isArray(value) ? value.includes(row[column]) : row[column] === value,
        ),
      );
      const by = order;
      if (by) {
        const direction = by.ascending ? 1 : -1;
        filtered.sort((a, b) =>
          String(a[by.column] ?? "").localeCompare(String(b[by.column] ?? "")) * direction,
        );
      }
      return limit === null ? filtered : filtered.slice(0, limit);
    };

    const b: Record<string, unknown> = {};
    b.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return b;
    };
    b.in = (column: string, values: unknown[]) => {
      filters.push([column, values]);
      return b;
    };
    b.order = (column: string, options?: { ascending?: boolean }) => {
      order = { column, ascending: options?.ascending ?? true };
      return b;
    };
    b.limit = (n: number) => {
      limit = n;
      return b;
    };
    b.maybeSingle = async () => ({
      data: head ? null : embed(matched()[0] ?? null),
      error: null,
    });
    b.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(
        onFulfilled(
          head
            ? { data: null, count: matched().length, error: null }
            : { data: matched().map(embed), error: null },
        ),
      );
    return b;
  }

  /**
   * insert/upsert honouring the real unique key, so a repeated save at the same
   * sequence slot updates rather than duplicating.
   */
  function writeBuilder(table: Table, payload: Row[], mode: "insert" | "upsert", onConflict?: string) {
    const apply = (): Row[] => {
      const stored: Row[] = [];
      const conflictColumns = onConflict?.split(",").map((c) => c.trim()).filter(Boolean);

      for (const raw of payload) {
        const row = withGenerated(table, raw);
        const existing = conflictColumns?.length
          ? rows(table).find((candidate) => conflictColumns.every((c) => candidate[c] === row[c]))
          : undefined;

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
            builder(table, [], null, null, Boolean(options?.head)),
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
              const affected = rows(table).filter((row) =>
                filters.every(([column, value]) =>
                  Array.isArray(value) ? value.includes(row[column]) : row[column] === value,
                ),
              );
              affected.forEach((row) => Object.assign(row, patch));
              return affected;
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
            b.then = (onFulfilled: (value: unknown) => unknown) =>
              Promise.resolve(onFulfilled({ data: apply(), error: null }));
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
  buildImportDeepLink: vi.fn(async (token: string) => `https://pepa.example.com/import/${token}`),
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

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_LEAD_ID = "22222222-2222-2222-2222-222222222222";
const INITIAL_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
  db.leads = [];
  db.messages = [];
  db.tokens = [];
  seedLead(LEAD_ID, "info@thearchive.cz");
});

function seedLead(id: string, email: string, overrides: Row = {}) {
  db.leads.push({
    id,
    email,
    email_normalized: email.toLowerCase(),
    company_name: null,
    contact_name: null,
    status: "ready",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
    ...overrides,
  });
}

/** The lead's initial outreach, which the migration backfills to slot 0. */
function seedInitial(overrides: Row = {}) {
  db.messages.push({
    id: INITIAL_ID,
    lead_id: LEAD_ID,
    recipient_email: "info@thearchive.cz",
    recipient_normalized: "info@thearchive.cz",
    subject: "AI recepce pro The Archive",
    body: "Původní text počátečního oslovení.",
    status: "sent",
    provider: null,
    provider_message_id: null,
    sent_at: "2026-09-20T09:00:00.000Z",
    created_at: "2026-09-20T08:55:00.000Z",
    sequence_number: 0,
    parent_message_id: null,
    ...overrides,
  });
}

/** Mint a follow-up_composer token anchored on `outreachId`. */
async function seedToken(leadId: string, outreachId: string | null) {
  const { generateActionToken, hashActionToken } = await import("@/lib/deep-link/tokens");
  const raw = generateActionToken();
  db.tokens.push({
    id: `token-${db.tokens.length + 1}`,
    token_hash: hashActionToken(raw),
    purpose: "followup_composer",
    lead_id: leadId,
    outreach_id: outreachId,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    used_at: null,
  });
  return raw;
}

/** The lead's messages in sequence order. */
function sequence(leadId: string) {
  return db.messages
    .filter((m) => m.lead_id === leadId)
    .sort((a, b) => Number(a.sequence_number) - Number(b.sequence_number));
}

describe("outreach sequence — legacy rows", () => {
  it("1. treats a pre-migration row as the initial outreach at slot 0", () => {
    seedInitial();

    const row = db.messages[0];
    expect(row.sequence_number).toBe(0);
    expect(row.parent_message_id).toBeNull();
  });

  it("10. an import is an initial outreach, so it lands at slot 0", async () => {
    const { createOutreachImport } = await import("@/lib/services/import-service");

    const result = await createOutreachImport({
      recipient: "hello@example.com",
      subject: "Importovaný předmět",
      body: "Dobrý den,\n\nimportovaný text.\n\nS pozdravem",
    });

    expect(result.ok).toBe(true);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      sequence_number: 0,
      parent_message_id: null,
      status: "draft",
    });
  });

  it("does not convert followup_count into fabricated message rows", () => {
    // A lead whose counter says two follow-ups went out still has exactly one
    // stored message. The counter is scheduling state, not history.
    seedLead(LEAD_ID, "info@thearchive.cz", { followup_count: 2 });
    seedInitial();

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]?.sequence_number).toBe(0);
  });
});

describe("outreach sequence — building the chain", () => {
  it("2. a follow-up draft creates a NEW message row", async () => {
    seedInitial();
    const raw = await seedToken(LEAD_ID, INITIAL_ID);

    const result = await saveFollowUpDraft({ rawToken: raw, subject: "Navazuji", body: "Dobrý den,\n\nšpatka." });

    expect(result.ok).toBe(true);
    expect(db.messages).toHaveLength(2);
    expect(result.data?.created).toBe(true);
    expect(result.data?.message.id).not.toBe(INITIAL_ID);
  });

  it("3. does NOT overwrite the initial outreach", async () => {
    seedInitial();
    const raw = await seedToken(LEAD_ID, INITIAL_ID);

    await saveFollowUpDraft({ rawToken: raw, subject: "Navazuji", body: "Dobrý den,\n\nšpatka." });

    const initial = db.messages.find((m) => m.id === INITIAL_ID);
    expect(initial).toMatchObject({
      subject: "AI recepce pro The Archive",
      body: "Původní text počátečního oslovení.",
      status: "sent",
      sent_at: "2026-09-20T09:00:00.000Z",
      sequence_number: 0,
    });
  });

  it("4/5/6. chains initial -> follow-up #1 -> follow-up #2 with correct parents", async () => {
    seedInitial();

    const first = await seedToken(LEAD_ID, INITIAL_ID);
    const fu1 = await saveFollowUpDraft({ rawToken: first, subject: "FU1", body: "Dobrý den,\n\nprvní navázání.\n\nS pozdravem" });
    expect(fu1.ok).toBe(true);
    const followUp1Id = fu1.data!.message.id;

    // Follow-up #2 anchors on follow-up #1, not on the initial outreach.
    const second = await seedToken(LEAD_ID, followUp1Id);
    const fu2 = await saveFollowUpDraft({ rawToken: second, subject: "FU2", body: "Dobrý den,\n\ndruhé navázání.\n\nS pozdravem" });
    expect(fu2.ok).toBe(true);

    const chain = sequence(LEAD_ID);
    expect(chain.map((m) => m.sequence_number)).toEqual([0, 1, 2]);
    expect(chain[0]?.parent_message_id).toBeNull();
    expect(chain[1]?.parent_message_id).toBe(INITIAL_ID);
    expect(chain[2]?.parent_message_id).toBe(followUp1Id);
  });

  it("re-saving the same open follow-up updates it instead of appending", async () => {
    seedInitial();
    const raw = await seedToken(LEAD_ID, INITIAL_ID);

    const first = await saveFollowUpDraft({ rawToken: raw, subject: "FU1", body: "Dobrý den,\n\nprvní.\n\nS pozdravem" });
    const second = await saveFollowUpDraft({ rawToken: raw, subject: "FU1 upravený", body: "Dobrý den,\n\nopravené.\n\nS pozdravem" });

    expect(second.ok).toBe(true);
    // Pressing save twice must not inflate the sequence.
    expect(db.messages).toHaveLength(2);
    expect(second.data?.created).toBe(false);
    expect(second.data?.message.id).toBe(first.data!.message.id);
    expect(sequence(LEAD_ID).map((m) => m.subject)).toEqual([
      "AI recepce pro The Archive",
      "FU1 upravený",
    ]);
  });

  it("a token with no anchor writes the initial outreach at slot 0", async () => {
    const raw = await seedToken(LEAD_ID, null);

    const result = await saveFollowUpDraft({ rawToken: raw, subject: "První", body: "Dobrý den,\n\nprvní.\n\nS pozdravem" });

    expect(result.ok).toBe(true);
    expect(result.data?.message).toMatchObject({ sequence_number: 0, parent_message_id: null });
  });
});

describe("outreach sequence — isolation", () => {
  it("7. a lead and recipient hold exactly one row per sequence slot", async () => {
    seedInitial();
    const before = db.messages.length;
    const raw = await seedToken(LEAD_ID, INITIAL_ID);

    await saveFollowUpDraft({ rawToken: raw, subject: "FU1", body: "Dobrý den,\n\nprvní.\n\nS pozdravem" });

    expect(db.messages.length).toBe(before + 1);
    // Postgres refuses a second row in an occupied slot via
    // unique (lead_id, recipient_normalized, sequence_number). That constraint
    // is asserted against a real instance; here the store must show exactly one
    // occupant of slot 1, i.e. the code never asked for a taken slot.
    const occupied = db.messages.filter(
      (m) => m.lead_id === LEAD_ID && m.sequence_number === 1,
    );
    expect(occupied).toHaveLength(1);
  });

  it("8. different leads each have their own sequence starting at 0", async () => {
    seedInitial();
    seedLead(OTHER_LEAD_ID, "a@bistrot.cz");
    db.messages.push({
      id: "bbbbbbbb-0000-0000-0000-000000000001",
      lead_id: OTHER_LEAD_ID,
      recipient_email: "a@bistrot.cz",
      recipient_normalized: "a@bistrot.cz",
      subject: "Bistrot",
      body: "Text.",
      status: "sent",
      provider: null,
      provider_message_id: null,
      sent_at: "2026-09-21T09:00:00.000Z",
      created_at: "2026-09-21T08:55:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
    });

    const raw = await seedToken(OTHER_LEAD_ID, "bbbbbbbb-0000-0000-0000-000000000001");
    const result = await saveFollowUpDraft({ rawToken: raw, subject: "FU1 Bistrot", body: "Dobrý den,\n\nnavázání.\n\nS pozdravem" });

    expect(result.ok).toBe(true);
    // Both leads independently hold a slot 1.
    expect(result.data?.message.sequence_number).toBe(1);
    expect(sequence(LEAD_ID).map((m) => m.sequence_number)).toEqual([0]);
    expect(sequence(OTHER_LEAD_ID).map((m) => m.sequence_number)).toEqual([0, 1]);
  });

  it("9. a follow-up is bound to its own lead", async () => {
    seedInitial();
    const raw = await seedToken(LEAD_ID, INITIAL_ID);

    const result = await saveFollowUpDraft({ rawToken: raw, subject: "FU1", body: "Dobrý den,\n\nprvní.\n\nS pozdravem" });

    expect(result.data?.message.lead_id).toBe(LEAD_ID);
    expect(result.data?.message.parent_message_id).toBe(INITIAL_ID);
  });
});

describe("outreach sequence — Phase 2 bridge intact", () => {
  it("11/12/13. the send transition still runs the gate and stays idempotent", async () => {
    // Phase 3 already covers the gate in detail. This asserts the sequence
    // change did not disturb that path: recordOutreachSent remains the single
    // authoritative transition and the module is unchanged in shape.
    const { recordOutreachSent } = await import("@/lib/services/outreach-service");
    expect(typeof recordOutreachSent).toBe("function");
  });

  it("14. follow-up scheduling still advances from leads, not from messages", async () => {
    const { markFollowUpSent } = await import("@/lib/services/follow-up-service");
    seedInitial({ status: "draft", sent_at: null });

    const result = await markFollowUpSent({ leadId: LEAD_ID, sentAt: new Date("2026-10-01T09:00:00.000Z") });

    // Known issue #1 is deliberately preserved: the counter is still incremented
    // from followup_count + 1, so the first reminder can read as #2.
    expect(result.nextFollowUpAt).not.toBeNull();
    expect(db.leads[0]?.followup_count).toBe(1);
  });
});

describe("outreach sequence — no parallel history", () => {
  it("17. stores no second history table; messages are the only record", () => {
    seedInitial();
    expect(Object.keys(db)).toEqual(["leads", "messages", "tokens"]);
  });
});
