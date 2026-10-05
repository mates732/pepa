import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordOutreachSent } from "./outreach-service";
import {
  parseHistoricalOutreachCsv,
  toHistoricalOutreachRow,
} from "@/lib/import/historical-outreach";
import { ALREADY_CONTACTED, ALREADY_CONTACTED_DOMAIN } from "@/lib/types";

/**
 * The historical-contact guard, exercised through the REAL send path.
 *
 * These tests do not call the gate directly. They call
 * `recordOutreachSent()` — the one function that can turn a draft into a
 * recorded send — and then read the store back. A test that called the gate in
 * isolation would still pass if somebody moved the check out of the send
 * transition, which is the exact regression the guard exists to prevent.
 *
 * The fake Supabase enforces the same invariants Postgres does: the unique
 * `leads.email_normalized`, the unique
 * `outreach_messages(lead_id, recipient_normalized, sequence_number)`, the
 * conditional UPDATE that only an unsent row matches, and the CHECK that a
 * `sent` row has a `sent_at`.
 */

/* -------------------------------------------------------------------------- */
/* fake database                                                               */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
type Filter = [string, unknown];

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const DRAFT_ID = "22222222-2222-2222-2222-222222222222";

const db = {
  leads: [] as Row[],
  messages: [] as Row[],
  historical: [] as Row[],
};

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** The columns Postgres generates. The application never writes them. */
function generated(table: string, row: Row): Row {
  if (table === "historical_outreach") {
    const domain = normalize(row.domain).replace(/^www\./, "");
    return {
      ...row,
      email_normalized: normalize(row.email),
      domain_normalized: domain,
      is_shared_provider: ["gmail.com", "seznam.cz", "outlook.com"].includes(domain),
    };
  }
  if (table === "outreach_messages") {
    return { ...row, recipient_normalized: normalize(row.recipient_email) };
  }
  if (table === "leads") return { ...row, email_normalized: normalize(row.email) };
  return row;
}

/**
 * Filter predicates, in the three shapes PostgREST supports.
 *
 * `is` and `not` are kept distinct on purpose: `.is(col, null)` means IS NULL
 * and `.not(col, "is", null)` means NOT NULL, which are opposite conditions and
 * both appear in the send path.
 */
type Predicate =
  | { kind: "eq"; value: unknown }
  | { kind: "in"; value: unknown[] }
  | { kind: "isNull" }
  | { kind: "notNull" }
  | { kind: "ne"; value: unknown };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([column, raw]) => {
    if (raw === null || typeof raw !== "object") return row[column] === raw;

    const predicate = raw as unknown as Predicate & Record<string, unknown>;
    if (predicate.kind === "eq") return row[column] === predicate.value;
    if (predicate.kind === "in") return (predicate.value as unknown[]).includes(row[column]);
    if (predicate.kind === "isNull") return row[column] === null;
    if (predicate.kind === "notNull") return row[column] !== null && row[column] !== undefined;
    return row[column] !== predicate.value;
  });
}

function store(table: string): Row[] {
  if (table === "leads") return db.leads;
  if (table === "outreach_messages") return db.messages;
  if (table === "historical_outreach") return db.historical;
  throw new Error(`unexpected table ${table}`);
}

function readBuilder(table: string, columns: string) {
  const filters: Filter[] = [];
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

  // PostgREST resolves the `outreach_messages(...)` embed into a nested array.
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
    filters.push([
      column,
      value === null ? { kind: "notNull" } : { kind: "ne", value },
    ]);
    return b;
  };
  b.order = (column: string, options: { ascending?: boolean }) => {
    order = { column, ascending: options?.ascending ?? true };
    return b;
  };
  // `limit(1)` is a no-op here because `maybeSingle()` already takes the first
  // row; the ordering above is what actually decides which one.
  b.limit = () => b;
  b.maybeSingle = async () => ({ data: decorate(matched()[0] ?? null), error: null });
  b.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: matched().map(decorate), error: null }));

  return b;
}

function updateBuilder(table: string, patch: Row) {
  const filters: Filter[] = [];
  const b: Record<string, unknown> = {};

  const apply = (): Row[] => {
    // Re-read the predicates at apply time, exactly as Postgres re-checks them
    // after taking the row lock.
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

  b.eq = (column: string, value: unknown) => {
    filters.push([column, { kind: "eq", value }]);
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
  b.select = () => b;
  b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
  b.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: apply(), error: null }));

  return b;
}

function insertBuilder(table: string, payload: Row | Row[]) {
  const list = Array.isArray(payload) ? payload : [payload];
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.then = (onFulfilled: (value: unknown) => unknown) => {
    const inserted: Row[] = [];
    for (const raw of list) {
      const row = generated(table, { id: `row-${Math.random()}`, ...raw });
      // UNIQUE(email_normalized) on historical_outreach — the idempotency
      // guarantee, enforced the way Postgres enforces it.
      if (
        table === "historical_outreach" &&
        store(table).some((existing) => existing.email_normalized === row.email_normalized)
      ) {
        const error = Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
        return Promise.resolve(onFulfilled({ data: null, error }));
      }
      store(table).push(row);
      inserted.push(row);
    }
    return Promise.resolve(onFulfilled({ data: inserted, error: null }));
  };
  return b;
}

function makeSupabase() {
  return {
    from(table: string) {
      return {
        select: (columns?: string) => readBuilder(table, columns ?? ""),
        insert: (payload: Row | Row[]) => insertBuilder(table, payload),
        update: (patch: Row) => updateBuilder(table, patch),
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ markFollowUpSent: vi.fn() }));
vi.mock("@/lib/services/follow-up-service", () => ({ markFollowUpSent: mocks.markFollowUpSent }));

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const DRAFT_BODY =
  "Dobrý den,\n\nrád bych vám nabídl automatizaci příchozích dotazů pro vaši společnost.\n\nS pozdravem";

/** A stored legacy contact, as the importer would have written it. */
function historical(overrides: Row = {}): Row {
  return generated("historical_outreach", {
    email: "info@bistro.cz",
    company: "Bistro",
    domain: "bistro.cz",
    contact_count: 3,
    first_contact_at: "2026-09-01T09:00:00.000Z",
    last_contact_at: "2026-09-18T09:00:00.000Z",
    subjects: "První dotaz || Ještě navazuji",
    source: "historical_import",
    ...overrides,
  });
}

function seedHistorical(rows: Row[]) {
  db.historical = rows;
}

function seedDraft(overrides: Row = {}) {
  db.leads = [
    {
      id: LEAD_ID,
      email: "info@bistro.cz",
      company_name: "Bistro",
      contact_name: null,
      status: "ready",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      last_contacted_at: null,
      next_followup_at: null,
      followup_count: 0,
      ...overrides,
    },
  ];
  db.messages = [
    {
      id: DRAFT_ID,
      lead_id: LEAD_ID,
      recipient_email: "info@bistro.cz",
      subject: "Automatizace dotazů",
      body: DRAFT_BODY,
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-10-01T00:00:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
      ...overrides,
    },
  ];
}

beforeEach(() => {
  db.leads = [];
  db.messages = [];
  db.historical = [];
  mocks.markFollowUpSent.mockReset();
  mocks.markFollowUpSent.mockResolvedValue({ nextFollowUpAt: "2026-10-08T00:00:00.000Z" });
});

/* -------------------------------------------------------------------------- */
/* TESTS 1–4 — the refusal and the permission                                  */
/* -------------------------------------------------------------------------- */

describe("TEST 1 — a historical contact blocks the send", () => {
  it("refuses to record the send and writes nothing", async () => {
    seedHistorical([historical()]);
    seedDraft();

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("blocked");
    if (result.data?.outcome !== "blocked") throw new Error("expected a blocked outcome");
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED);
    expect(result.data.error).toContain(
      "Cannot send outreach: this email address was already contacted on 2026-09-18.",
    );
    // Nothing was recorded and nothing was scheduled.
    expect(db.messages[0]!.status).toBe("draft");
    expect(db.messages[0]!.sent_at).toBeNull();
    expect(mocks.markFollowUpSent).not.toHaveBeenCalled();
  });

  it("names the historical date and the number of contacts", async () => {
    seedHistorical([historical({ contact_count: 7 })]);
    seedDraft();

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    if (result.data?.outcome !== "blocked") throw new Error("expected a blocked outcome");
    const check = result.data.gate.checks.find((c) => c.name === "already_contacted");
    expect(check?.evidence).toContain("7 contacts on record");
    expect(check?.evidence).toContain("imported history");
  });
});

describe("TEST 2 — capitalization cannot hide a historical contact", () => {
  it("blocks when the draft address differs only in case", async () => {
    // The legacy account spelled it `Info@Bistro.CZ`.
    seedHistorical([historical({ email: "Info@Bistro.CZ" })]);
    seedDraft({ recipient_email: "info@bistro.cz" });

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("blocked");
    if (result.data?.outcome !== "blocked") throw new Error("expected a blocked outcome");
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED);
    expect(db.messages[0]!.sent_at).toBeNull();
  });
});

describe("TEST 3 — surrounding whitespace cannot hide a historical contact", () => {
  it("blocks when the draft address carries stray spaces", async () => {
    seedHistorical([historical()]);
    seedDraft({ recipient_email: "  info@bistro.cz  " });

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("blocked");
    if (result.data?.outcome !== "blocked") throw new Error("expected a blocked outcome");
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED);
  });
});

describe("TEST 4 — an untouched address is still allowed", () => {
  it("records the send for a lead with no history at all", async () => {
    seedDraft();

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.ok ? result.data?.outcome : result.error).toBe("recorded");
    expect(db.messages[0]!.status).toBe("sent");
  });

  it("allows an address that shares only a provider domain with a historical one", async () => {
    seedHistorical([historical({ email: "trener@gmail.com", domain: "gmail.com" })]);
    seedDraft({
      recipient_email: "recepce@gmail.com",
      email: "recepce@gmail.com",
    });
    db.leads[0]!.email = "recepce@gmail.com";

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("recorded");
  });
});

/* -------------------------------------------------------------------------- */
/* TEST 5 — age of the contact                                                 */
/* -------------------------------------------------------------------------- */

describe("TEST 5 — an old contact is not turned into an infinite block", () => {
  it("still refuses a NEW cold outreach, however long ago it was", async () => {
    // Well past the 3-day cooldown. A permanent guard has to survive that, or
    // every imported contact becomes pitchable again after three days.
    seedHistorical([
      historical({ last_contact_at: "2025-01-05T09:00:00.000Z", first_contact_at: "2024-12-01T09:00:00.000Z" }),
    ]);
    seedDraft();

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("blocked");
    if (result.data?.outcome !== "blocked") throw new Error("expected a blocked outcome");
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED);
  });

  it("does NOT block a follow-up in a sequence Pepa is already running", async () => {
    // Follow-ups are not cold outreach: they continue a conversation Pepa
    // started, so the finite cooldown and the 4/7/10 cadence still govern them.
    // Without this, the historical import would freeze the follow-up engine.
    seedHistorical([
      historical({ last_contact_at: "2025-01-05T09:00:00.000Z", first_contact_at: "2024-12-01T09:00:00.000Z" }),
    ]);
    const ANCHOR_ID = "33333333-3333-3333-3333-333333333333";
    seedDraft();
    db.messages.push({
      id: ANCHOR_ID,
      lead_id: LEAD_ID,
      recipient_email: "info@bistro.cz",
      subject: "Původní oslovení",
      body: "Dobrý den,\n\nnavazuji na předchozí email s nabídkou pro vaši společnost.\n\nS pozdravem",
      status: "sent",
      provider: null,
      provider_message_id: null,
      sent_at: "2026-10-01T09:00:00.000Z",
      created_at: "2026-10-01T09:00:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
    });
    Object.assign(db.messages[0]!, { sequence_number: 1, parent_message_id: ANCHOR_ID });
    db.leads[0]!.last_contacted_at = "2026-10-01T09:00:00.000Z";

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    // NOT "blocked": the permanent historical refusal does not apply to a
    // follow-up. What remains is the ordinary finite-cooldown warning, which
    // asks the operator to confirm and then proceeds.
    expect(result.data?.outcome).toBe("needs_confirmation");

    const confirmed = await recordOutreachSent({
      messageId: DRAFT_ID,
      leadId: LEAD_ID,
      confirmWarnings: true,
    });

    expect(confirmed.data?.outcome).toBe("recorded");
    expect(db.messages.find((m) => m.id === DRAFT_ID)?.sent_at).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* TEST 6 — shared providers must never cross-block                           */
/* -------------------------------------------------------------------------- */

describe("TEST 6 — two unrelated businesses on a shared mailbox", () => {
  it("blocks only the address that was actually contacted", async () => {
    seedHistorical([
      historical({ email: "a.gym@gmail.com", domain: "gmail.com", company: "Gym A", contact_count: 2 }),
    ]);
    seedDraft({ recipient_email: "b.restaurant@gmail.com" });
    db.leads[0]!.email = "b.restaurant@gmail.com";

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("recorded");
  });

  it("blocks the exact gmail address that was contacted", async () => {
    seedHistorical([
      historical({ email: "a.gym@gmail.com", domain: "gmail.com", contact_count: 2 }),
    ]);
    seedDraft({ recipient_email: "a.gym@gmail.com" });
    db.leads[0]!.email = "a.gym@gmail.com";

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("blocked");
    if (result.data?.outcome !== "blocked") throw new Error("expected a blocked outcome");
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED);
  });

  it.each(["seznam.cz", "outlook.com"])(
    "never cross-blocks two unrelated %s recipients",
    async (provider) => {
      seedHistorical([
        historical({ email: `prvni@${provider}`, domain: provider, contact_count: 1 }),
      ]);
      seedDraft({ recipient_email: `druhy@${provider}` });
      db.leads[0]!.email = `druhy@${provider}`;

      const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

      expect(result.data?.outcome).toBe("recorded");
    },
  );

  it("does apply the company-level guard to a company's own domain", async () => {
    // A second mailbox at the same company is still a second pitch to a company
    // that has already heard from us.
    seedHistorical([historical({ email: "info@bistro.cz", domain: "bistro.cz" })]);
    seedDraft({ recipient_email: "objednavky@bistro.cz" });
    db.leads[0]!.email = "objednavky@bistro.cz";

    const result = await recordOutreachSent({ messageId: DRAFT_ID, leadId: LEAD_ID });

    expect(result.data?.outcome).toBe("blocked");
    if (result.data?.outcome !== "blocked") throw new Error("expected a blocked outcome");
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED_DOMAIN);
    expect(result.data.error).toContain("bistro.cz");
    expect(result.data.error).toContain("info@bistro.cz");
  });
});

/* -------------------------------------------------------------------------- */
/* TEST 7 — the import is idempotent                                          */
/* -------------------------------------------------------------------------- */

const EXPORT = `email,company,domain,contact_count,first_contact,last_contact,subjects
info@bistro.cz,Bistro,bistro.cz,3,2026-09-01T09:00:00+00:00,2026-09-18T09:00:00+00:00,"První dotaz || Ještě navazuji"
recepce@gmail.com,,gmail.com,1,2026-09-20T09:00:00+00:00,2026-09-20T09:00:00+00:00,Malá nabídka
`;

describe("TEST 7 — importing the same export twice creates no duplicates", () => {
  it("produces identical, canonical rows on both runs", () => {
    const first = parseHistoricalOutreachCsv(EXPORT);
    const second = parseHistoricalOutreachCsv(EXPORT);

    expect(first.rejections).toEqual([]);
    expect(first.contacts).toHaveLength(2);
    // Byte-identical output is what makes the second run a no-op rather than an
    // update: the unique constraint sees the same canonical addresses.
    expect(toHistoricalOutreachRow(first.contacts[0]!)).toEqual(
      toHistoricalOutreachRow(second.contacts[0]!),
    );
    expect(first.contacts[0]!.normalizedEmail).toBe("info@bistro.cz");
    expect(first.contacts[1]!.normalizedEmail).toBe("recepce@gmail.com");
    expect(first.contacts[0]!.lastContactAt).toBe("2026-09-18T09:00:00.000Z");
    expect(first.contacts[0]!.subjects).toBe("První dotaz || Ještě navazuji");
  });

  it("refuses a second insert of the same canonical address", async () => {
    const parsed = parseHistoricalOutreachCsv(EXPORT);
    const supabase = makeSupabase();
    const rows = parsed.contacts.map(toHistoricalOutreachRow) as unknown as Row[];

    const first = await supabase.from("historical_outreach").insert(rows);
    expect((first as { error: unknown }).error ?? null).toBeNull();

    const second = await supabase.from("historical_outreach").insert(rows);
    const error = (second as { error: { code?: string } | null }).error;
    expect(error?.code).toBe("23505");
    // One row per address, still.
    expect(db.historical).toHaveLength(2);
  });

  it("merges a repeated address inside one file instead of dropping a row", () => {
    const duplicated = `${EXPORT}info@bistro.cz,Bistro,www.bistro.cz,5,2026-08-01T09:00:00+00:00,2026-10-01T09:00:00+00:00,Nový předmět\n`;
    const parsed = parseHistoricalOutreachCsv(duplicated);

    expect(parsed.contacts).toHaveLength(2);
    expect(parsed.duplicatesMerged).toBe(1);
    const merged = parsed.contacts.find((c) => c.normalizedEmail === "info@bistro.cz")!;
    expect(merged.firstContactAt).toBe("2026-08-01T09:00:00.000Z");
    expect(merged.lastContactAt).toBe("2026-10-01T09:00:00.000Z");
    expect(merged.contactCount).toBe(5);
    // `www.` is stripped, so the company-level identity is the same one.
    expect(merged.domain).toBe("bistro.cz");
  });

  it("reports every unusable row instead of silently skipping it", () => {
    const broken = `email,company,domain,contact_count,first_contact,last_contact,subjects
not-an-email,X,x.cz,1,2026-09-01T00:00:00+00:00,2026-09-02T00:00:00+00:00,Subject
ok@bistro.cz,Bistro,bistro.cz,1,nonsense,2026-09-02T00:00:00+00:00,Subject
`;
    const parsed = parseHistoricalOutreachCsv(broken);

    expect(parsed.contacts).toHaveLength(0);
    expect(parsed.rejections.map((r) => r.line)).toEqual([2, 3]);
  });
});