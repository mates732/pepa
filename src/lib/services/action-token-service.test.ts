import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateActionToken, hashActionToken } from "@/lib/deep-link/tokens";

/**
 * Exercises the deep-link resolution rules against a fake Supabase client:
 * format rejection, digest lookup, purpose scoping, expiry and lead resolution.
 */

const state = {
  tokens: [] as Array<Record<string, unknown>>,
  leads: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  selects: [] as string[],
};

const supabaseMock = {
  from(table: string) {
    const rowsFor = () =>
      table === "action_tokens" ? state.tokens : table === "leads" ? state.leads : state.messages;

    return {
      select(columns: string, options?: { head?: boolean }) {
        state.selects.push(`${table}:${columns}`);
        // PostgREST AND-s every .eq() in the chain.
        const filters: Array<[string, unknown]> = [];
        const builder: Record<string, unknown> = {};
        let order: { column: string; ascending: boolean } | null = null;
        let limit: number | null = null;

        const matched = () => {
          const filtered = rowsFor().filter((row) =>
            filters.every(([column, value]) =>
              Array.isArray(value)
                ? value.includes(row[column])
                : row[column] === value,
            ),
          );
          // PostgREST applies ORDER BY before LIMIT, and the sequence code depends
          // on it: "the highest sequence_number" is only correct if the fake
          // actually sorts.
          const by = order;
          if (by) {
            const direction = by.ascending ? 1 : -1;
            filtered.sort((a, b) => {
              const av = String(a[by.column] ?? "");
              const bv = String(b[by.column] ?? "");
              return av.localeCompare(bv) * direction;
            });
          }
          return limit === null ? filtered : filtered.slice(0, limit);
        };

        const resolve = () => {
          const rows = matched();
          if (options?.head) return { count: rows.length, data: null, error: null };
          const found = rows[0];
          if (!found) return { data: null, error: null };

          // Emulate PostgREST's embedded relations on action_tokens.
          if ("lead_id" in found) {
            const { lead_id, outreach_id, ...token } = found;
            return {
              data: {
                ...token,
                leads: state.leads.find((l) => l.id === lead_id) ?? null,
                outreach_messages:
                  state.messages.find((m) => m.id === outreach_id) ?? null,
              },
              error: null,
            };
          }
          return { data: found, error: null };
        };

        builder.eq = (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        };
        builder.in = (column: string, values: unknown[]) => {
          filters.push([column, values]);
          return builder;
        };
        builder.maybeSingle = resolve;
        builder.single = resolve;
        builder.limit = (n: number) => {
          limit = n;
          return builder;
        };
        builder.order = (column: string, opts?: { ascending?: boolean }) => {
          order = { column, ascending: opts?.ascending ?? true };
          return builder;
        };
        // Thenable so `await supabase.from(..).select(..).eq(..)` works too.
        builder.then = (resolve_: (value: unknown) => unknown) =>
          Promise.resolve(resolve()).then(resolve_);
        return builder;
      },
      insert(payload: Array<Record<string, unknown>> | Record<string, unknown>) {
        const rows = Array.isArray(payload) ? payload : [payload];
        let inserted: () => Array<Record<string, unknown>>;
        if (table === "action_tokens") {
          const start = state.tokens.length;
          for (const row of rows) {
            state.tokens.push({ id: `token-${state.tokens.length + 1}`, ...row });
          }
          // The engine only needs the stored row back, which is what
          // `.select().maybeSingle()` returns in production.
          inserted = () => state.tokens.slice(start);
        } else if (table === "outreach_messages") {
          // A follow-up draft is a NEW row: Postgres assigns the id and stores it.
          // This is what the sequence model depends on.
          const start = state.messages.length;
          for (const row of rows) {
            state.messages.push({ id: `msg-${state.messages.length + 1}`, ...row });
          }
          inserted = () => state.messages.slice(start);
        } else {
          inserted = () => [];
        }

        // PostgREST: insert() is thenable and can chain .select().maybeSingle()
        // to read the stored row back.
        const builder: Record<string, unknown> = {
          select: () => builder,
          maybeSingle: async () => ({ data: inserted()[0] ?? null, error: null }),
          then: (resolve_: (value: unknown) => unknown) =>
            Promise.resolve({ data: inserted(), error: null }).then(resolve_),
        };
        return builder;
      },
      update(patch: Record<string, unknown>) {
        // Mirrors the real builder: chainable synchronously, thenable so `await`
        // on a bare update() still resolves to { error }.
        let updated: Record<string, unknown> | null = null;
        const builder: Record<string, unknown> = {
          select: () => ({ maybeSingle: async () => ({ data: updated, error: null }) }),
          then: (resolve: (value: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        builder.eq = (column: string, value: unknown) => {
          for (const row of rowsFor()) {
            if (row[column] === value) {
              Object.assign(row, patch);
              updated = row;
            }
          }
          return builder;
        };
        return builder;
      },
      async upsert(payload: Array<Record<string, unknown>>) {
        state.messages.push(...payload);
        return { error: null, data: payload[0] };
      },
    };
  },
};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => ({ name: "pepa_session", value: process.env.VALID_SESSION ?? "" }),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => supabaseMock }));
vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: async () => ({ id: "owner", since: 0 }),
}));

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = "test-secret-that-is-definitely-longer-than-32-chars";
  state.tokens = [];
  state.leads = [];
  state.messages = [];
  state.selects = [];

  state.leads.push({
    id: LEAD_ID,
    email: "info@thearchive.cz",
    company_name: "The Archive",
    contact_name: null,
    status: "follow_up",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-30T00:00:00Z",
    last_contacted_at: "2026-09-30T00:00:00Z",
    next_followup_at: "2026-10-07T00:00:00Z",
    followup_count: 1,
  });
  state.messages.push({
    id: MESSAGE_ID,
    lead_id: LEAD_ID,
    recipient_email: "info@thearchive.cz",
    subject: "Re: AI recepce",
    body: "Dobrý den,",
    status: "follow_up",
    provider: "gmail",
    provider_message_id: "abc123",
    sent_at: "2026-09-30T00:00:00Z",
    created_at: "2026-09-30T00:00:00Z",
    // This is the initial outreach: slot 0, no predecessor.
    sequence_number: 0,
    parent_message_id: null,
  });
});

async function load() {
  return import("@/lib/services/action-token-service");
}

function seedToken(overrides: Record<string, unknown> = {}) {
  const raw = generateActionToken();
  state.tokens.push({
    id: "33333333-3333-3333-3333-333333333333",
    token_hash: hashActionToken(raw),
    purpose: "followup_composer",
    lead_id: LEAD_ID,
    outreach_id: MESSAGE_ID,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    used_at: null,
    ...overrides,
  });
  return raw;
}

describe("createFollowUpToken", () => {
  it("stores only the digest and returns the raw token once", async () => {
    const { createFollowUpToken } = await load();
    const result = await createFollowUpToken({ leadId: LEAD_ID });

    expect(result.ok).toBe(true);
    const raw = result.data?.token ?? "";
    expect(raw).toMatch(/^fp1_/);

    const stored = state.tokens[0];
    expect(stored.token_hash).toBe(hashActionToken(raw));
    expect(JSON.stringify(state.tokens)).not.toContain(raw);
    expect(stored.purpose).toBe("followup_composer");
    expect(Date.parse(String(stored.expires_at))).toBeGreaterThan(Date.now());
    expect(result.data?.id).toBe(stored.id);
  });

  it("refuses to mint for a lead that does not exist", async () => {
    state.leads = [];
    const { createFollowUpToken } = await load();
    const result = await createFollowUpToken({ leadId: LEAD_ID });
    expect(result.ok).toBe(false);
  });
});

describe("resolveActionToken", () => {
  it("resolves a valid token to its lead and outreach context", async () => {
    const raw = seedToken();
    const { resolveActionToken } = await load();

    const result = await resolveActionToken(raw, "followup_composer");
    expect(result.ok).toBe(true);
    expect(result.data?.lead.id).toBe(LEAD_ID);
    expect(result.data?.lead.email).toBe("info@thearchive.cz");
    expect(result.data?.outreach?.id).toBe(MESSAGE_ID);
  });

  it("stamps first use without invalidating the token", async () => {
    const raw = seedToken();
    const { resolveActionToken } = await load();

    await resolveActionToken(raw, "followup_composer");
    expect(state.tokens[0].used_at).toBeTruthy();
    await resolveActionToken(raw, "followup_composer");
    expect(state.tokens[0].used_at).toBeTruthy();
  });

  it("rejects a token that does not exist", async () => {
    const { resolveActionToken } = await load();
    const result = await resolveActionToken(generateActionToken(), "followup_composer");
    expect(result.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const raw = seedToken({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const { resolveActionToken } = await load();
    const result = await resolveActionToken(raw, "followup_composer");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed or guessed identifier without a database lookup", async () => {
    const { resolveActionToken } = await load();

    for (const candidate of ["1", "00000000-0000-0000-0000-000000000000", "../../leads", ""]) {
      const result = await resolveActionToken(candidate, "followup_composer");
      expect(result.ok).toBe(false);
    }
    expect(state.selects).toHaveLength(0);
  });

  it("cannot be retargeted: a token minted for one lead never resolves to another", async () => {
    const raw = seedToken();
    state.leads.push({
      ...state.leads[0],
      id: "99999999-9999-9999-9999-999999999999",
      email: "other@example.com",
    });
    const { resolveActionToken } = await load();

    const result = await resolveActionToken(raw, "followup_composer");
    expect(result.data?.lead.id).toBe(LEAD_ID);
  });

  it("gives one indistinguishable message for every failure mode", async () => {
    const { resolveActionToken, INVALID_TOKEN_MESSAGE } = await load();

    const missing = await resolveActionToken(generateActionToken(), "followup_composer");
    const expiredRaw = seedToken({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await resolveActionToken(expiredRaw, "followup_composer");
    const malformed = await resolveActionToken("1", "followup_composer");

    expect(missing.error).toBe(INVALID_TOKEN_MESSAGE);
    expect(expired.error).toBe(INVALID_TOKEN_MESSAGE);
    expect(malformed.error).toBe(INVALID_TOKEN_MESSAGE);
  });

  it("fails closed when the signing secret is missing", async () => {
    const raw = seedToken();
    delete process.env.PEPA_SESSION_SECRET;

    const { resolveActionToken, INVALID_TOKEN_MESSAGE } = await load();
    const result = await resolveActionToken(raw, "followup_composer");
    expect(result.ok).toBe(false);
    expect(result.error).toBe(INVALID_TOKEN_MESSAGE);
  });
});

describe("saveFollowUpDraft", () => {
  it("writes the draft to the token's own lead", async () => {
    const raw = seedToken();
    const { saveFollowUpDraft } = await load();

    const result = await saveFollowUpDraft({ rawToken: raw, subject: "Re: AI recepce", body: "Navazuji" });
    expect(result.ok).toBe(true);
    expect(result.data?.message.lead_id).toBe(LEAD_ID);
    // The follow-up is a NEW row in the sequence, not an overwrite of the
    // anchor, so the anchor must still be there and still be slot 0.
    expect(state.messages).toHaveLength(2);
    expect(result.data?.message.id).not.toBe(MESSAGE_ID);
    expect(result.data?.message.sequence_number).toBe(1);
    expect(result.data?.message.parent_message_id).toBe(MESSAGE_ID);
    expect(state.messages[0]).toMatchObject({
      id: MESSAGE_ID,
      sequence_number: 0,
      parent_message_id: null,
      body: "Dobrý den,",
    });
  });

  it("refuses an invalid token without writing anything", async () => {
    const before = state.messages.length;
    const { saveFollowUpDraft } = await load();

    const result = await saveFollowUpDraft({ rawToken: "1", subject: "x", body: "y" });
    expect(result.ok).toBe(false);
    expect(state.messages.length).toBe(before);
  });
});