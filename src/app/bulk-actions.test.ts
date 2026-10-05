import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/token";
import { BULK_IMPORT_CHUNK_SIZE, failedRows } from "@/lib/import/bulk-plan";

/**
 * Paste Emails — the workflow, end to end.
 *
 * These are the thirteen cases the brief asks for, plus the safety test that
 * matters most.
 *
 * The services are NOT mocked. Only Supabase, the session and the cache are, so
 * a request travels the production path:
 *
 *   action -> requireAuthenticatedUser -> parseBulkEmails -> findLeadByEmail
 *          -> historical_outreach lookup -> createDraft -> outreach_messages
 *
 * That matters for three of the tests specifically. A suite that stubbed
 * `findLeadByEmail` would pass whether or not the bulk action actually consults
 * the historical table — which is the one thing this feature must never get
 * wrong — and one that stubbed `createDraft` could not tell a draft upsert from
 * an insert, nor prove the subject and body arrived unchanged.
 */

/* -------------------------------------------------------------------------- */
/* in-memory Supabase                                                          */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

type Predicate =
  | { kind: "eq"; value: unknown }
  | { kind: "neq"; value: unknown }
  | { kind: "in"; value: unknown[] }
  | { kind: "isNull" }
  | { kind: "notNull" };

const db = { leads: [] as Row[], messages: [] as Row[], historical: [] as Row[] };

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Mirrors the generated columns the migrations create. */
function withGenerated(table: string, row: Row): Row {
  if (table === "historical_outreach") {
    const domain = normalize(row.domain).replace(/^www\./, "");
    return {
      ...row,
      email_normalized: normalize(row.email),
      domain_normalized: domain,
      is_shared_provider: ["gmail.com", "seznam.cz", "outlook.com"].includes(domain),
    };
  }
  if (table === "leads") return { ...row, email_normalized: normalize(row.email) };
  if (table === "outreach_messages") {
    return { ...row, recipient_normalized: normalize(row.recipient_email) };
  }
  return row;
}

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, raw]) => {
    if (raw === null || typeof raw !== "object") return row[column] === raw;
    const p = raw as Predicate;
    if (p.kind === "eq") return row[column] === p.value;
    if (p.kind === "neq") return row[column] !== p.value;
    if (p.kind === "in") return (p.value as unknown[]).includes(row[column]);
    if (p.kind === "notNull") return row[column] !== null && row[column] !== undefined;
    return row[column] === null;
  });
}

function tableOf(name: string): Row[] {
  if (name === "leads") return db.leads;
  if (name === "outreach_messages") return db.messages;
  if (name === "historical_outreach") return db.historical;
  throw new Error(`unexpected table ${name}`);
}

/**
 * The "this table cannot be read" switch.
 *
 * `findHistoricalContact()` must PROPAGATE a failed lookup rather than treat it
 * as "nothing on record" — an outreach system that fails open is the bug this
 * whole guard exists to prevent. Seeding `{ __throw: true }` puts a marker row
 * in the table; every read of it returns a Supabase error, which is what the
 * real database does when a query fails.
 */
function throwOnRead(name: string): boolean {
  return tableOf(name).some((row) => row.__throw === true);
}

function selectBuilder(table: string, columns: string) {
  const filters: Array<[string, unknown]> = [];
  let order: { column: string; ascending: boolean } | null = null;
  const b: Record<string, unknown> = {};

  const matched = (): Row[] => {
    let rows = tableOf(table).filter((row) => matches(row, filters));
    if (order) {
      const direction = order.ascending ? 1 : -1;
      rows = [...rows].sort((a, c) =>
        String(a[order!.column] ?? "").localeCompare(String(c[order!.column] ?? "")) * direction,
      );
    }
    return rows;
  };

  /** Only `findLeadByEmail` asks for the nested relation. */
  const decorate = (row: Row | null): Row | null => {
    if (!row) return null;
    if (!columns.includes("outreach_messages(")) return row;
    const { outreach_messages: _drop, ...rest } = row;
    void _drop;
    return {
      ...rest,
      outreach_messages: db.messages
        .filter((m) => m.lead_id === row.id)
        .map(({ id, status, sent_at, created_at }) => ({ id, status, sent_at, created_at })),
    };
  };

  b.eq = (column: string, value: unknown) => {
    filters.push([column, value === null ? { kind: "isNull" } : { kind: "eq", value }]);
    return b;
  };
  b.neq = (column: string, value: unknown) => {
    filters.push([column, { kind: "neq", value }]);
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
  b.order = (column: string, options: { ascending?: boolean }) => {
    order = { column, ascending: options?.ascending ?? true };
    return b;
  };
  b.limit = () => b;
  b.select = () => b;
  b.maybeSingle = async () =>
    throwOnRead(table)
      ? { data: null, error: { message: `${table} is unreadable` } }
      : { data: decorate(matched()[0] ?? null), error: null };
  b.then = (onFulfilled: (value: unknown) => unknown) =>
    throwOnRead(table)
      ? Promise.resolve(onFulfilled?.({ data: null, error: { message: `${table} is unreadable` } }))
      : Promise.resolve(onFulfilled({ data: matched().map(decorate), error: null }));

  return b;
}

/** Addresses whose insert must fail, to exercise partial-failure handling. */
const failInserts = new Set<string>();

/**
 * `createLead` upserts an ARRAY, `createDraft` upserts a single object. Both go
 * through here, so normalise whatever arrived before iterating.
 */
function upsertBuilder(table: string, input: Row | Row[]) {
  const b: Record<string, unknown> = {};
  /** Rows written by the pending upsert, so `.select()` can read them back. */
  let written: Row[] = [];
  let failure: string | null = null;
  let done = false;

  /**
   * Apply the pending write.
   *
   * Lazy, because `createDraft` chains `.upsert(...).select(...).maybeSingle()`
   * rather than awaiting the builder: a fake that only wrote on `then` would
   * report "Draft could not be saved" for a save that actually succeeded. The
   * read-back is what tells the service whether it created or refreshed a
   * draft, which is exactly what the retry assertions depend on.
   */
  function run(): void {
    if (done) return;
    done = true;
    written = [];
    failure = null;

    for (const incoming of Array.isArray(input) ? input : [input]) {
      const generated = withGenerated(table, incoming);
      const normalizedEmail = String(
        generated.email_normalized ?? generated.recipient_normalized ?? "",
      );
      if (failInserts.has(normalizedEmail)) {
        failure = "insert failed";
        return;
      }

      // `leads` upserts on the normalized address; `outreach_messages` upserts on
      // (lead_id, recipient_normalized, sequence_number). Modelling both is what
      // makes a repeated import observable as a refresh rather than a duplicate.
      const existing =
        table === "leads"
          ? tableOf(table).find((row) => row.email_normalized === normalizedEmail)
          : tableOf(table).find(
              (row) =>
                row.lead_id === generated.lead_id &&
                row.recipient_normalized === normalizedEmail &&
                row.sequence_number === generated.sequence_number,
            );

      if (table === "leads") {
        if (existing) continue; // ignoreDuplicates: true
        const created = withGenerated(table, {
          id: `lead-${tableOf(table).length + 1}`,
          created_at: "2026-10-05T00:00:00.000Z",
          updated_at: "2026-10-05T00:00:00.000Z",
          status: "draft",
          contact_name: null,
          last_contacted_at: null,
          next_followup_at: null,
          followup_count: 0,
          ...incoming,
        });
        tableOf(table).push(created);
        written.push(created);
        continue;
      }

      if (existing) {
        // ignoreDuplicates: false — the slot is refreshed in place.
        Object.assign(existing, generated);
        written.push(existing);
        continue;
      }
      const created = withGenerated(table, {
        id: `msg-${tableOf(table).length + 1}`,
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "2026-10-05T00:00:00.000Z",
        parent_message_id: null,
        ...incoming,
      });
      tableOf(table).push(created);
      written.push(created);
    }
  }

  b.onConflict = () => b;
  b.select = () => b;
  b.maybeSingle = async () => {
    run();
    return failure
      ? { data: null, error: { message: failure } }
      : { data: written[0] ?? null, error: null };
  };
  b.then = (onFulfilled: (value: unknown) => unknown) => {
    run();
    return Promise.resolve(
      onFulfilled?.(failure ? { data: null, error: { message: failure } } : { data: null, error: null }),
    );
  };

  return b;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      return {
        select: (columns?: string) => selectBuilder(table, columns ?? ""),
        upsert: (rows: Row | Row[]) => upsertBuilder(table, rows),
      };
    },
  }),
}));

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) } : undefined,
  }),
  headers: async () => new Headers(),
}));

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

function seedHistory(email: string, overrides: Partial<Row> = {}) {
  db.historical.push(
    withGenerated("historical_outreach", {
      id: `hist-${db.historical.length + 1}`,
      email,
      company: "Historical Co",
      domain: email.split("@")[1] ?? "",
      contact_count: 4,
      first_contact_at: "2026-09-01T09:00:00.000Z",
      last_contact_at: "2026-09-18T09:00:00.000Z",
      subjects: "První dotaz || Ještě navazuji",
      source: "historical_import",
      ...overrides,
    }),
  );
}

function seedLead(email: string, overrides: Partial<Row> = {}) {
  db.leads.push(
    withGenerated("leads", {
      id: `lead-${db.leads.length + 1}`,
      email,
      company_name: "Firma ABC",
      contact_name: null,
      status: "draft",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      last_contacted_at: null,
      next_followup_at: null,
      followup_count: 0,
      ...overrides,
    }),
  );
}

/** A finished email, exactly as an operator would paste it. */
function email(recipient: string, subject: string, body = "Dobrý den,\n\ntext.\n\nS pozdravem") {
  return `To: ${recipient}\nSubject: ${subject}\n${body}`;
}

function twentyEmails(): string {
  return Array.from({ length: 20 }, (_, i) =>
    email(`info@firma${i + 1}.cz`, `Nabídka ${i + 1}`, `Dobrý den,\n\ntext firmy ${i + 1}.\n\nS pozdravem`),
  ).join("\n\n---\n\n");
}

/** Twenty leads, one per pasted email, so all twenty are importable. */
function seedTwentyLeads() {
  for (let i = 1; i <= 20; i += 1) seedLead(`info@firma${i}.cz`);
}

async function authenticate() {
  cookieStore.set(SESSION_COOKIE, createSessionToken());
}

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
  db.leads = [];
  db.messages = [];
  db.historical = [];
  cookieStore.clear();
  failInserts.clear();
  mocks.revalidatePath.mockReset();
});

/* -------------------------------------------------------------------------- */
/* tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("TEST 1 and 11 — twenty finished emails become twenty drafts", () => {
  it("parses all twenty and saves twenty independent drafts", async () => {
    seedTwentyLeads();
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(twentyEmails());
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.plan.summary.total).toBe(20);
    expect(preview.plan.summary.ready).toBe(20);

    const requests = preview.plan.rows
      .filter((row) => row.status === "ready")
      .map((row) => ({ index: row.index, recipient: row.recipient!, subject: row.subject, body: row.body }));

    const result = await importBulkEmails(requests);
    if (!result.ok) throw new Error(result.error);

    expect(result.rows).toHaveLength(20);
    expect(result.rows.every((row) => row.outcome === "created")).toBe(true);
    expect(db.messages).toHaveLength(20);

    // Each draft belongs to its own lead and its own message row. No email was
    // merged and none was reused.
    expect(new Set(db.messages.map((m) => m.lead_id)).size).toBe(20);
    expect(new Set(db.messages.map((m) => m.recipient_email)).size).toBe(20);
    expect(new Set(result.rows.map((row) => row.messageId)).size).toBe(20);
  });

  it("keeps twenty distinct subjects — no draft inherits another's", async () => {
    seedTwentyLeads();
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(twentyEmails());
    if (!preview.ok) throw new Error(preview.error);

    await importBulkEmails(
      preview.plan.rows
        .filter((row) => row.status === "ready")
        .map((row) => ({ index: row.index, recipient: row.recipient!, subject: row.subject, body: row.body })),
    );

    expect(new Set(db.messages.map((m) => m.subject)).size).toBe(20);
    expect(db.messages[0]!.subject).toBe("Nabídka 1");
  });
});

describe("TEST 2, 3 and 10 — recipient, subject and body reach the draft intact", () => {
  it("stores exactly what was pasted", async () => {
    seedLead("info@bella.cz");
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const body = "Dobrý den,\n\nrád bych vám ukázal, jak lze zlepšit váš web.\n\nS pozdravem\nPetr";
    const preview = await previewBulkEmails(
      `To: Kadeřnictví Bella <INFO@Bella.CZ>\nSubject: Váš web\n${body}`,
    );
    if (!preview.ok) throw new Error(preview.error);

    const row = preview.plan.rows[0]!;
    expect(row.recipient).toBe("info@bella.cz");
    expect(row.subject).toBe("Váš web");
    expect(row.body).toBe(body);

    const result = await importBulkEmails([
      { index: 1, recipient: row.recipient!, subject: row.subject, body: row.body },
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.rows[0]!.outcome).toBe("created");

    const stored = db.messages[0]!;
    expect(stored.recipient_email).toBe("info@bella.cz");
    expect(stored.subject).toBe("Váš web");
    expect(stored.body).toBe(body);
  });

  it("does not rewrite, shorten or reword a single character", async () => {
    seedLead("info@bella.cz");
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    // Deliberately awkward text: a dash range, a URL with a query string, a Czech
    // sentence, and a signature divider. None of it may be tidied away — the only
    // permitted change is whitespace normalization, so a trailing space on the
    // signature line is dropped and everything else is byte-identical.
    const body = [
      "Dobrý den,",
      "",
      "Rozsah: 5 - 10 dní. Viz https://firma.cz/nabidka?a=1&b=2",
      "",
      "S pozdravem",
      "",
      "-- ",
      "Petr Novák",
      "jednatel",
    ].join("\n");
    const tidied = body.replace(/[ \t]+$/gm, "").trim();

    const preview = await previewBulkEmails(`To: info@bella.cz\nSubject: Nabídka — 5–10 dní\n${body}`);
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.plan.rows[0]!.body).toBe(tidied);

    await importBulkEmails([
      {
        index: 1,
        recipient: "info@bella.cz",
        subject: preview.plan.rows[0]!.subject,
        body: preview.plan.rows[0]!.body,
      },
    ]);

    expect(db.messages[0]!.body).toBe(tidied);
    expect(db.messages[0]!.subject).toBe("Nabídka — 5–10 dní");
    // The em dash, the URL, the query string and the dash range all survive.
    expect(db.messages[0]!.body).toContain("a=1&b=2");
    expect(db.messages[0]!.body).toContain("5 - 10 dní");
  });
});

describe("TEST 5 — an existing lead is matched", () => {
  it("attaches the draft to the lead and shows its company", async () => {
    seedLead("info@bella.cz", { company_name: "Kadeřnictví Bella" });
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(email("info@bella.cz", "Váš web"));
    if (!preview.ok) throw new Error(preview.error);

    const row = preview.plan.rows[0]!;
    expect(row.status).toBe("ready");
    expect(row.leadCompany).toBe("Kadeřnictví Bella");
    expect(row.leadId).toBeTruthy();

    const result = await importBulkEmails([
      { index: 1, recipient: row.recipient!, subject: row.subject, body: row.body },
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]!.lead_id).toBe(row.leadId);
    // No second lead was made for an address that already had one.
    expect(db.leads).toHaveLength(1);
  });
});

describe("TEST 6 — a missing lead is NOT a blocker", () => {
  it("plans an unknown recipient as READY and creates the lead and the draft", async () => {
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    // No lead exists, and that changes nothing about a finished email.
    expect(db.leads).toHaveLength(0);

    const preview = await previewBulkEmails(email("neznama@firma-ktera-nemexistuje.cz", "Nabídka"));
    if (!preview.ok) throw new Error(preview.error);

    const row = preview.plan.rows[0]!;
    expect(row.status).toBe("ready");
    expect(row.reason).toBeNull();
    expect(preview.plan.summary.ready).toBe(1);
    expect(preview.plan.summary.importable).toBe(1);
    // The preview still writes nothing, so `leadId` is genuinely absent here.
    expect(row.leadId).toBeNull();
    expect(db.leads).toHaveLength(0);

    const result = await importBulkEmails([
      { index: 1, recipient: row.recipient!, subject: row.subject, body: row.body },
    ]);
    if (!result.ok) throw new Error(result.error);

    // A lead was created for the recipient, and the draft hangs off it.
    expect(result.rows[0]!.outcome).toBe("created");
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0]!.email).toBe("neznama@firma-ktera-nemexistuje.cz");
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]!.lead_id).toBe(db.leads[0]!.id);

    // And it is an ordinary slot-0 draft, not a special one.
    expect(db.messages[0]!.sequence_number).toBe(0);
    expect(db.messages[0]!.status).toBe("draft");
    expect(db.messages[0]!.sent_at).toBeNull();
    expect(db.messages[0]!.subject).toBe("Nabídka");
    expect(result.rows[0]!.leadId).toBe(db.leads[0]!.id);
  });

  it("does not derive a company name from the email domain", async () => {
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(email("info@bella.cz", "Nabídka"));
    if (!preview.ok) throw new Error(preview.error);

    // "bella" is inferable from the domain, and Pepa still does not.
    expect(preview.plan.rows[0]!.leadCompany).toBeNull();

    await importBulkEmails([
      { index: 1, recipient: "info@bella.cz", subject: "Nabídka", body: "text" },
    ]);

    // The lead exists, but with no invented identity written into it.
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0]!.company_name).toBeNull();
    expect(db.leads[0]!.contact_name).toBeNull();
    // And certainly nothing guessed appears in the email itself.
    expect(db.messages[0]!.subject).toBe("Nabídka");
    expect(String(db.messages[0]!.body)).toBe("text");
  });

  it("reuses an existing lead as-is rather than making a second one", async () => {
    seedLead("info@bella.cz", { company_name: "Kadeřnictví Bella" });
    await authenticate();
    const { importBulkEmails } = await import("@/app/bulk-actions");

    await importBulkEmails([
      { index: 1, recipient: "info@bella.cz", subject: "Nabídka", body: "text" },
    ]);

    expect(db.leads).toHaveLength(1);
    // `createLead` upserts with ignoreDuplicates, so the operator's own company
    // name survives an import rather than being blanked by a NULL upsert.
    expect(db.leads[0]!.company_name).toBe("Kadeřnictví Bella");
  });

  it("re-importing an unknown recipient refreshes the draft instead of duplicating it", async () => {
    await authenticate();
    const { importBulkEmails } = await import("@/app/bulk-actions");
    const row = {
      index: 1,
      recipient: "neznama@firma-ktera-nemexistuje.cz",
      subject: "Nabídka",
      body: "text",
    };

    const first = await importBulkEmails([row]);
    if (!first.ok) throw new Error(first.error);
    expect(first.rows[0]!.outcome).toBe("created");

    const second = await importBulkEmails([row]);
    if (!second.ok) throw new Error(second.error);
    expect(second.rows[0]!.outcome).toBe("already_present");

    expect(db.leads).toHaveLength(1);
    expect(db.messages).toHaveLength(1);
    expect(second.rows[0]!.messageId).toBe(first.rows[0]!.messageId);
    expect(second.rows[0]!.leadId).toBe(first.rows[0]!.leadId);
  });

  it("still refuses an unknown address that history has already reached", async () => {
    // No lead, no prior Pepa contact — but the legacy account pitched it, so
    // the missing lead must not open the door history closes.
    seedHistory("info@salonabc.cz");
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(email("info@salonabc.cz", "AI recepce"));
    if (!preview.ok) throw new Error(preview.error);

    expect(preview.plan.rows[0]!.status).toBe("already_contacted");
    expect(preview.plan.summary.importable).toBe(0);

    const result = await importBulkEmails([
      { index: 1, recipient: "info@salonabc.cz", subject: "AI recepce", body: "text" },
    ]);
    if (!result.ok) throw new Error(result.error);

    expect(result.rows[0]!.outcome).toBe("skipped");
    expect(db.leads).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
  });
});

describe("TEST 7 and the SAFETY TEST — a historical contact can never be drafted", () => {
  it("marks the address ALREADY CONTACTED and imports nothing", async () => {
    seedHistory("info@salonabc.cz");
    await authenticate();
    const { previewBulkEmails } = await import("@/app/bulk-actions");

    const result = await previewBulkEmails(email("info@salonabc.cz", "AI recepce"));

    if (!result.ok) throw new Error(result.error);
    const row = result.plan.rows[0]!;
    expect(row.status).toBe("already_contacted");
    expect(row.blockReason).toBe("ALREADY_CONTACTED");
    expect(row.reason).toContain("Already contacted");
    expect(row.contactCount).toBe(4);
    expect(result.plan.summary.importable).toBe(0);
  });

  it("blocks a company-domain match as well as an exact address", async () => {
    seedHistory("info@salonabc.cz");
    await authenticate();
    const { previewBulkEmails } = await import("@/app/bulk-actions");

    const result = await previewBulkEmails(email("objednavky@salonabc.cz", "AI recepce"));

    if (!result.ok) throw new Error(result.error);
    expect(result.plan.rows[0]!.status).toBe("already_contacted");
    expect(result.plan.rows[0]!.blockReason).toBe("ALREADY_CONTACTED_DOMAIN");
  });

  it("refuses even when a caller posts a historical address directly", async () => {
    seedHistory("info@salonabc.cz");
    seedLead("info@salonabc.cz");
    await authenticate();
    const { importBulkEmails } = await import("@/app/bulk-actions");

    // The strongest form of the test: the row is well formed, the lead EXISTS,
    // and it is named directly by the client. History still wins.
    const result = await importBulkEmails([
      { index: 1, recipient: "info@salonabc.cz", subject: "AI recepce", body: "text" },
    ]);

    if (!result.ok) throw new Error(result.error);
    expect(result.rows[0]!.outcome).toBe("skipped");
    expect(result.rows[0]!.error).toContain("Already on record");
    expect(db.messages).toHaveLength(0);
  });

  it("matches regardless of case and whitespace in the paste", async () => {
    seedHistory("info@salonabc.cz");
    await authenticate();
    const { previewBulkEmails } = await import("@/app/bulk-actions");

    const result = await previewBulkEmails("To:    INFO@SalonABC.CZ   \nSubject: X\ntext");

    if (!result.ok) throw new Error(result.error);
    expect(result.plan.rows[0]!.status).toBe("already_contacted");
  });

  it("still lets an unrelated business on a shared provider through", async () => {
    seedHistory("nekdo@gmail.com", { domain: "gmail.com" });
    seedLead("jina.firma@gmail.com");
    await authenticate();
    const { previewBulkEmails } = await import("@/app/bulk-actions");

    const result = await previewBulkEmails(email("jina.firma@gmail.com", "Nabídka"));

    if (!result.ok) throw new Error(result.error);
    expect(result.plan.rows[0]!.status).toBe("ready");
  });
});

describe("TEST 8 — duplicate recipients in one paste", () => {
  it("marks the repeat DUPLICATE and creates one draft", async () => {
    seedLead("info@bella.cz");
    seedLead("barber@barberx.cz");
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(
      [
        email("info@bella.cz", "První verze", "první text"),
        email("INFO@BELLA.CZ", "Druhá verze", "druhý text"),
        email("barber@barberx.cz", "Třetí", "třetí text"),
      ].join("\n\n---\n\n"),
    );
    if (!preview.ok) throw new Error(preview.error);

    expect(preview.plan.summary.ready).toBe(2);
    expect(preview.plan.summary.duplicates).toBe(1);
    const duplicate = preview.plan.rows[1]!;
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.duplicateOf).toBe(1);
    // The duplicate keeps its own text so the operator can compare and decide.
    expect(duplicate.subject).toBe("Druhá verze");

    const result = await importBulkEmails(
      preview.plan.rows
        .filter((row) => row.status === "ready")
        .map((row) => ({ index: row.index, recipient: row.recipient!, subject: row.subject, body: row.body })),
    );
    if (!result.ok) throw new Error(result.error);

    expect(db.messages).toHaveLength(2);
    expect(db.messages.filter((m) => m.recipient_email === "info@bella.cz")).toHaveLength(1);
    // The first copy wins, so its text is the one stored.
    expect(db.messages.find((m) => m.recipient_email === "info@bella.cz")!.subject).toBe("První verze");
  });
});

describe("TEST 9 — one malformed block does not destroy the other nineteen", () => {
  it("keeps nineteen and flags the one for review", async () => {
    for (let i = 1; i <= 20; i += 1) seedLead(`info@firma${i}.cz`);
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const blocks = Array.from({ length: 20 }, (_, i) =>
      email(`info@firma${i + 1}.cz`, `S${i + 1}`, `text ${i + 1}`),
    );
    blocks[7] = "Subject: bez adresáte\ntext bez adresáte";

    const preview = await previewBulkEmails(blocks.join("\n\n---\n\n"));
    if (!preview.ok) throw new Error(preview.error);

    expect(preview.plan.summary.total).toBe(20);
    expect(preview.plan.summary.ready).toBe(19);
    expect(preview.plan.summary.needsReview).toBe(1);
    expect(preview.plan.rows[7]!.status).toBe("needs_review");
    expect(preview.plan.rows[7]!.recipient).toBeNull();

    // The neighbours are untouched.
    expect(preview.plan.rows[6]!.recipient).toBe("info@firma7.cz");
    expect(preview.plan.rows[8]!.recipient).toBe("info@firma9.cz");

    const result = await importBulkEmails(
      preview.plan.rows
        .filter((row) => row.status === "ready")
        .map((row) => ({ index: row.index, recipient: row.recipient!, subject: row.subject, body: row.body })),
    );
    if (!result.ok) throw new Error(result.error);
    expect(db.messages).toHaveLength(19);
  });

  it("survives a database failure on one email and saves the rest", async () => {
    for (let i = 1; i <= 20; i += 1) seedLead(`info@firma${i}.cz`);
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");
    const { summarizeOutcomes } = await import("@/lib/import/bulk-plan");

    const preview = await previewBulkEmails(twentyEmails());
    if (!preview.ok) throw new Error(preview.error);

    const requests = preview.plan.rows
      .filter((row) => row.status === "ready")
      .map((row) => ({ index: row.index, recipient: row.recipient!, subject: row.subject, body: row.body }));

    failInserts.add("info@firma8.cz");

    const result = await importBulkEmails(requests);
    if (!result.ok) throw new Error(result.error);

    const totals = summarizeOutcomes(result.rows);
    expect(totals.failed).toBe(1);
    expect(totals.succeeded).toBe(19);
    expect(db.messages).toHaveLength(19);

    // The retry list is exactly the email that failed.
    const retry = failedRows(result.rows);
    expect(retry).toHaveLength(1);
    expect(retry[0]!.recipient).toBe("info@firma8.cz");

    // And the retry creates it without touching the other nineteen.
    failInserts.clear();
    const source = preview.plan.rows.find((row) => row.recipient === "info@firma8.cz")!;
    const second = await importBulkEmails([
      { index: source.index, recipient: source.recipient!, subject: source.subject, body: source.body },
    ]);
    if (!second.ok) throw new Error(second.error);
    expect(second.rows[0]!.outcome).toBe("created");
    expect(db.messages).toHaveLength(20);
  });
});

describe("TEST 12 — nothing is ever sent", () => {
  it("creates drafts and leaves every send field alone", async () => {
    seedTwentyLeads();
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(twentyEmails());
    if (!preview.ok) throw new Error(preview.error);
    await importBulkEmails(
      preview.plan.rows
        .filter((row) => row.status === "ready")
        .map((row) => ({ index: row.index, recipient: row.recipient!, subject: row.subject, body: row.body })),
    );

    expect(db.messages).toHaveLength(20);
    expect(db.messages.every((m) => m.status === "draft")).toBe(true);
    expect(db.messages.every((m) => m.sent_at === null)).toBe(true);
    expect(db.messages.every((m) => m.sequence_number === 0)).toBe(true);
    // No follow-up was scheduled, because nothing was sent.
    expect(db.leads.every((l) => l.last_contacted_at === null)).toBe(true);
    expect(db.leads.every((l) => l.next_followup_at === null)).toBe(true);
    expect(db.leads.every((l) => l.followup_count === 0)).toBe(true);
  });

  it("exposes no send path in the bulk actions module", async () => {
    const bulkActions = await import("@/app/bulk-actions");

    // Exactly the two entry points, and nothing that could send or generate.
    expect(Object.keys(bulkActions).sort()).toEqual([
      "importBulkEmails",
      "previewBulkEmails",
    ]);
  });
});

describe("TEST 13 — the single-email flow is unchanged", () => {
  it("still parses one pasted email", async () => {
    const { parseOutreachInput } = await import("@/lib/parser");

    const parsed = parseOutreachInput(
      "recipient: info@bella.cz\nsubject: AI recepce pro Bella\nbody: Dobrý den,\n\nrád bych vám ukázal řešení.",
    );

    expect(parsed.recipient).toBe("info@bella.cz");
    expect(parsed.subject).toBe("AI recepce pro Bella");
    expect(parsed.missing).toEqual([]);
  });

  it("still saves one draft through the existing composer action", async () => {
    seedLead("info@bella.cz");
    await authenticate();
    const { saveDraft } = await import("@/app/actions");

    const result = await saveDraft({
      recipientEmail: "info@bella.cz",
      subject: "AI recepce",
      body: "Dobrý den, text",
    });

    expect(result.ok).toBe(true);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]!.subject).toBe("AI recepce");
  });

  it("still refuses a malformed recipient through that same action", async () => {
    await authenticate();
    const { saveDraft } = await import("@/app/actions");

    const result = await saveDraft({ recipientEmail: "not-an-email", subject: "x", body: "y" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("not a valid email address");
    expect(db.messages).toHaveLength(0);
  });
});

describe("bulk import — resilience and bounds", () => {
  it("fails a row closed when the history lookup throws", async () => {
    db.historical.push({ __throw: true } as Row);
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const result = await previewBulkEmails(email("info@bella.cz", "X"));

    if (!result.ok) throw new Error(result.error);
    // The table could not be read, so the row is FAILED — never quietly ready,
    // because "I could not check" is not "nothing is on record".
    expect(result.plan.rows[0]!.status).toBe("failed");
    expect(result.plan.summary.ready).toBe(0);
    expect(result.plan.summary.importable).toBe(0);

    // And asking the import directly still writes nothing.
    const imported = await importBulkEmails([
      { index: 1, recipient: "info@bella.cz", subject: "X", body: "text" },
    ]);
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.rows[0]!.outcome).toBe("skipped");
    expect(db.leads).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
  });

  it("rejects an oversized request instead of acting on part of it silently", async () => {
    await authenticate();
    const { importBulkEmails } = await import("@/app/bulk-actions");

    const rows = Array.from({ length: BULK_IMPORT_CHUNK_SIZE * 3 + 1 }, (_, i) => ({
      index: i + 1,
      recipient: `info@firma${i + 1}.cz`,
      subject: "X",
      body: "text",
    }));

    const result = await importBulkEmails(rows);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(db.messages).toHaveLength(0);
  });

  it("requires a session for both actions", async () => {
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    await expect(previewBulkEmails(twentyEmails())).rejects.toThrow("Not authenticated.");
    await expect(
      importBulkEmails([{ index: 1, recipient: "info@bella.cz", subject: "X", body: "y" }]),
    ).rejects.toThrow("Not authenticated.");
  });

  it("explains an empty paste rather than importing nothing quietly", async () => {
    await authenticate();
    const { previewBulkEmails } = await import("@/app/bulk-actions");

    const result = await previewBulkEmails("   \n\n  ");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toContain("Nothing to parse");
  });

  it("importing the same paste twice refreshes the drafts instead of duplicating", async () => {
    seedTwentyLeads();
    await authenticate();
    const { previewBulkEmails, importBulkEmails } = await import("@/app/bulk-actions");

    const preview = await previewBulkEmails(twentyEmails());
    if (!preview.ok) throw new Error(preview.error);
    const requests = preview.plan.rows
      .filter((row) => row.status === "ready")
      .map((row) => ({ index: row.index, recipient: row.recipient!, subject: row.subject, body: row.body }));

    const first = await importBulkEmails(requests);
    if (!first.ok) throw new Error(first.error);
    expect(first.rows.every((row) => row.outcome === "created")).toBe(true);

    const second = await importBulkEmails(requests);
    if (!second.ok) throw new Error(second.error);

    expect(db.messages).toHaveLength(20);
    expect(db.leads).toHaveLength(20);
    expect(new Set(second.rows.map((row) => row.messageId)).size).toBe(20);
  });
});