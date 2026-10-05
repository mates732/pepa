import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/token";
import { ALREADY_CONTACTED } from "@/lib/types";

/**
 * TEST 8 — the guard is not a UI feature.
 *
 * This test calls the `recordOutreachSent` SERVER ACTION directly, with a
 * valid session cookie, no page rendered, no button disabled and no client-side
 * badge consulted. If the refusal only lived in the composer, this request
 * would succeed and a historical contact could be mailed a second time by
 * anything that can speak HTTP: a crafted fetch, curl, a stale tab, a
 * replayed action call.
 *
 * The services are NOT mocked here. Only Supabase, the session and the
 * follow-up scheduler are, so the request travels the production path:
 * action -> requireAuthenticatedUser -> recordOutreachSent() service ->
 * evaluateStoredMessageQualityGate() -> historical_outreach lookup -> refusal.
 */

type Row = Record<string, unknown>;
type Predicate =
  | { kind: "eq"; value: unknown }
  | { kind: "in"; value: unknown[] }
  | { kind: "isNull" }
  | { kind: "notNull" }
  | { kind: "ne"; value: unknown };

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const DRAFT_ID = "22222222-2222-2222-2222-222222222222";

const db = { leads: [] as Row[], messages: [] as Row[], historical: [] as Row[] };

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function generated(table: string, row: Row): Row {
  if (table === "historical_outreach") {
    const domain = normalize(row.domain).replace(/^www\./, "");
    return {
      ...row,
      email_normalized: normalize(row.email),
      domain_normalized: domain,
      is_shared_provider: domain === "gmail.com" || domain === "seznam.cz",
    };
  }
  if (table === "outreach_messages") {
    return { ...row, recipient_normalized: normalize(row.recipient_email) };
  }
  return row;
}

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, raw]) => {
    if (raw === null || typeof raw !== "object") return row[column] === raw;
    const p = raw as unknown as Predicate & Record<string, unknown>;
    if (p.kind === "eq") return row[column] === p.value;
    if (p.kind === "in") return (p.value as unknown[]).includes(row[column]);
    if (p.kind === "isNull") return row[column] === null;
    if (p.kind === "notNull") return row[column] !== null && row[column] !== undefined;
    return row[column] !== p.value;
  });
}

function store(table: string): Row[] {
  if (table === "leads") return db.leads;
  if (table === "outreach_messages") return db.messages;
  if (table === "historical_outreach") return db.historical;
  throw new Error(`unexpected table ${table}`);
}

function builder(table: string, columns: string) {
  const filters: Array<[string, unknown]> = [];
  let order: { column: string; ascending: boolean } | null = null;
  const b: Record<string, unknown> = {};

  const matched = (): Row[] => {
    let rows = store(table).filter((row) => matches(row, filters));
    if (order) {
      const direction = order.ascending ? 1 : -1;
      rows = [...rows].sort((a, c) =>
        String(a[order!.column] ?? "").localeCompare(String(c[order!.column] ?? "")) * direction,
      );
    }
    return rows;
  };

  const decorate = (row: Row | null): Row | null => {
    if (!row) return null;
    if (!columns.includes("outreach_messages(")) return row;
    const { outreach_messages: _ignored, ...rest } = row;
    void _ignored;
    return {
      ...rest,
      outreach_messages: db.messages
        .filter((m) => m.lead_id === row.id)
        .map(({ id, status, sent_at, created_at }) => ({ id, status, sent_at, created_at })),
    };
  };

  b.eq = (column: string, value: unknown) => {
    filters.push([column, { kind: "eq", value }]);
    return b;
  };
  b.neq = (column: string, value: unknown) => {
    filters.push([column, { kind: "ne", value }]);
    return b;
  };
  b.in = (column: string, values: unknown[]) => {
    filters.push([column, { kind: "in", value: values }]);
    return b;
  };
  b.is = (column: string, value: null) => {
    filters.push([column, value === null ? { kind: "isNull" } : { kind: "eq", value }]);
    return b;
  };
  b.not = (column: string, _op: string, value: unknown) => {
    filters.push([column, value === null ? { kind: "notNull" } : { kind: "ne", value }]);
    return b;
  };
  b.order = (column: string, options: { ascending?: boolean }) => {
    order = { column, ascending: options?.ascending ?? true };
    return b;
  };
  b.limit = () => b;
  b.select = () => b;
  b.maybeSingle = async () => ({ data: decorate(matched()[0] ?? null), error: null });
  b.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: matched().map(decorate), error: null }));

  return b;
}

function updateBuilder(table: string, patch: Row) {
  const filters: Array<[string, unknown]> = [];
  const b = builder(table, "");
  void b;
  const u: Record<string, unknown> = {};

  const apply = (): Row[] => {
    const affected = store(table).filter((row) => matches(row, filters));
    for (const row of affected) {
      const next = { ...row, ...patch };
      if (next.status === "sent" && !next.sent_at) {
        throw new Error("violates outreach_messages_sent_at_status_check");
      }
      Object.assign(row, next);
    }
    return affected;
  };

  u.eq = (column: string, value: unknown) => {
    filters.push([column, { kind: "eq", value }]);
    return u;
  };
  u.in = (column: string, values: unknown[]) => {
    filters.push([column, { kind: "in", value: values }]);
    return u;
  };
  u.is = (column: string, value: null) => {
    filters.push([column, value === null ? { kind: "isNull" } : { kind: "eq", value }]);
    return u;
  };
  u.select = () => u;
  u.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
  u.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: apply(), error: null }));

  return u;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      return {
        select: (columns?: string) => builder(table, columns ?? ""),
        update: (patch: Row) => updateBuilder(table, patch),
      };
    },
  }),
}));

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  markFollowUpSent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/services/follow-up-service", () => ({ markFollowUpSent: mocks.markFollowUpSent }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) } : undefined,
  }),
  headers: async () => new Headers(),
}));

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

function seed(recipient: string, historical: boolean) {
  db.leads = [
    {
      id: LEAD_ID,
      email: recipient,
      company_name: "Bistro",
      contact_name: null,
      status: "ready",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      last_contacted_at: null,
      next_followup_at: null,
      followup_count: 0,
    },
  ];
  db.messages = [
    {
      id: DRAFT_ID,
      lead_id: LEAD_ID,
      recipient_email: recipient,
      subject: "Automatizace dotazů",
      body: "Dobrý den,\n\nrád bych vám nabídl automatizaci příchozích dotazů pro vaši společnost.\n\nS pozdravem",
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-10-01T00:00:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
    },
  ];
  db.historical = historical
    ? [
        generated("historical_outreach", {
          id: "hist-1",
          email: recipient,
          company: "Bistro",
          domain: recipient.split("@")[1] ?? "bistro.cz",
          contact_count: 4,
          first_contact_at: "2026-09-01T09:00:00.000Z",
          last_contact_at: "2026-09-18T09:00:00.000Z",
          subjects: "První dotaz || Ještě navazuji",
          source: "historical_import",
        }),
      ]
    : [];
}

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
  db.leads = [];
  db.messages = [];
  db.historical = [];
  cookieStore.clear();
  mocks.markFollowUpSent.mockReset();
  mocks.revalidatePath.mockReset();
});

describe("TEST 8 — a direct call to the send endpoint is refused", () => {
  it("rejects an authenticated request for a historically contacted recipient", async () => {
    seed("info@bistro.cz", true);
    cookieStore.set(SESSION_COOKIE, createSessionToken());

    const { recordOutreachSent } = await import("@/app/actions");
    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.ok).toBe(false);
    if (result.ok || !("outcome" in result)) throw new Error("expected a blocked refusal");
    expect(result.outcome).toBe("blocked");
    expect(result.blockReason).toBe(ALREADY_CONTACTED);
    expect(result.error).toContain("already contacted on 2026-09-18");

    // The database is untouched: no sent state, no follow-up scheduled, and the
    // page is not revalidated into a state the operator never reached.
    expect(db.messages[0]!.status).toBe("draft");
    expect(db.messages[0]!.sent_at).toBeNull();
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("cannot be walked around by asking for the confirmation flag", async () => {
    seed("info@bistro.cz", true);
    cookieStore.set(SESSION_COOKIE, createSessionToken());

    const { recordOutreachSent } = await import("@/app/actions");
    const result = await recordOutreachSent({
      messageId: DRAFT_ID,
      leadId: LEAD_ID,
      confirmWarnings: true,
    });

    // `confirmWarnings` waives WARNINGS. A block is not a warning, and must not
    // become sendable by asking twice.
    expect(result.ok).toBe(false);
    expect(db.messages[0]!.sent_at).toBeNull();
  });

  it("still records the send for an address with no history", async () => {
    seed("novy@bistro.cz", false);
    cookieStore.set(SESSION_COOKIE, createSessionToken());

    const { recordOutreachSent } = await import("@/app/actions");
    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.ok).toBe(true);
    expect(db.messages[0]!.status).toBe("sent");
  });

  it("is refused before authentication can be used to argue about it", async () => {
    seed("info@bistro.cz", true);
    // No session cookie at all.
    const { recordOutreachSent } = await import("@/app/actions");

    await expect(recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID })).rejects.toThrow(
      "Not authenticated.",
    );
    expect(db.messages[0]!.sent_at).toBeNull();
  });
});