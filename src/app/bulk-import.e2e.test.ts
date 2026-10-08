import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/token";
import { BULK_IMPORT_CHUNK_SIZE } from "@/lib/import/bulk-plan";

/**
 * Paste Emails — end-to-end verification of the real operator workflow.
 *
 * One realistic batch of ten finished emails, taken all the way through:
 *
 *   PASTE → PARSE → PREVIEW → MATCH → IMPORT → DRAFTS → OPEN IN COMPOSER
 *
 * This is deliberately a separate file from `bulk-actions.test.ts`. That suite
 * tests one requirement at a time; this one pastes a batch that contains every
 * awkward case at once and asserts that the operator ends up with exactly the
 * drafts they should have and nothing else. A per-requirement suite can all pass
 * while the batch as a whole produces a surprising result.
 *
 * The services are NOT mocked — only Supabase, the session and the cache — so
 * the batch travels the production path:
 *
 *   previewBulkEmails → parseBulkEmails → findLeadByEmail → historical_outreach
 *   importBulkEmails  → re-check → createDraft → outreach_messages
 *   listOutreachHistory / loadInitialOutreachDetail → the real dashboard views
 *
 * Nothing here sends an email, and there is no code path that could.
 */

/* -------------------------------------------------------------------------- */
/* in-memory Supabase                                                          */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

const db = {
  leads: [] as Row[],
  messages: [] as Row[],
  historical: [] as Row[],
  /** Rows `outreach_overview` would return: one per lead with its latest message. */
  overview: [] as Row[],
};

function normalize(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function withGenerated(table: string, row: Row): Row {
  if (table === "historical_outreach") {
    const domain = normalize(row.domain).replace(/^www\./, "");
    return {
      ...row,
      email_normalized: normalize(row.email),
      domain_normalized: domain,
      is_shared_provider: ["gmail.com", "seznam.cz", "outlook.com"].includes(
        domain,
      ),
    };
  }
  if (table === "leads")
    return { ...row, email_normalized: normalize(row.email) };
  if (table === "outreach_messages") {
    return { ...row, recipient_normalized: normalize(row.recipient_email) };
  }
  return row;
}

type Predicate =
  | { kind: "eq"; value: unknown }
  | { kind: "neq"; value: unknown }
  | { kind: "in"; value: unknown[] }
  | { kind: "isNull" };

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, raw]) => {
    if (raw === null || typeof raw !== "object") return row[column] === raw;
    const p = raw as Predicate;
    if (p.kind === "eq") return row[column] === p.value;
    if (p.kind === "neq") return row[column] !== p.value;
    if (p.kind === "in") return (p.value as unknown[]).includes(row[column]);
    return row[column] === null;
  });
}

/** The four tables the services touch, including the dashboard's overview view. */
function tableOf(name: string): Row[] {
  if (name === "leads") return db.leads;
  if (name === "outreach_messages") return db.messages;
  if (name === "historical_outreach") return db.historical;
  if (name === "outreach_overview") return db.overview;
  throw new Error(`unexpected table ${name}`);
}

function selectBuilder(table: string, columns: string) {
  const filters: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {};

  const matched = (): Row[] => {
    let rows = tableOf(table).filter((row) => matches(row, filters));
    if (table === "outreach_overview") {
      // The real view joins each lead to its latest message.
      rows = rows.map((lead) => {
        const messages = db.messages
          .filter((m) => m.lead_id === lead.id)
          .sort((a, c) =>
            String(a.created_at).localeCompare(String(c.created_at)),
          );
        const latest = messages[messages.length - 1];
        return {
          ...lead,
          latest_subject: latest?.subject ?? null,
          latest_message_status: latest?.status ?? null,
          latest_message_at: latest?.created_at ?? null,
          message_count: messages.length,
          last_followup_notified_number: null,
          last_followup_notified_at: null,
        };
      });
    }
    if (table === "leads" && columns.includes("outreach_messages(")) {
      rows = rows.map((lead) => {
        const { outreach_messages: _drop, ...rest } = lead;
        void _drop;
        return {
          ...rest,
          outreach_messages: db.messages
            .filter((m) => m.lead_id === lead.id)
            .map(({ id, status, sent_at, created_at }) => ({
              id,
              status,
              sent_at,
              created_at,
            })),
        };
      });
    }
    return rows;
  };

  b.eq = (column: string, value: unknown) => {
    filters.push([
      column,
      value === null ? { kind: "isNull" } : { kind: "eq", value },
    ]);
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
  b.or = () => b;
  b.is = (column: string, value: null) => {
    filters.push([
      column,
      value === null ? { kind: "isNull" } : { kind: "eq", value },
    ]);
    return b;
  };
  b.order = () => b;
  b.limit = () => b;
  b.select = () => b;
  b.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
  b.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: matched(), error: null }));

  return b;
}

function upsertBuilder(table: string, input: Row | Row[]) {
  const b: Record<string, unknown> = {};
  let written: Row[] = [];

  function run(): void {
    written = [];
    for (const incoming of Array.isArray(input) ? input : [input]) {
      const generated = withGenerated(table, incoming);
      const key = String(
        generated.email_normalized ?? generated.recipient_normalized ?? "",
      );

      const existing =
        table === "leads"
          ? tableOf(table).find((row) => row.email_normalized === key)
          : tableOf(table).find(
              (row) =>
                row.lead_id === generated.lead_id &&
                row.recipient_normalized === key &&
                row.sequence_number === generated.sequence_number,
            );

      if (table === "leads") {
        if (existing) continue;
        const created = withGenerated(table, {
          id: uuid(1000 + db.leads.length),
          created_at: "2026-10-05T00:00:00.000Z",
          updated_at: "2026-10-05T00:00:00.000Z",
          status: "draft",
          contact_name: null,
          last_contacted_at: null,
          next_followup_at: null,
          followup_count: 0,
          ...incoming,
        });
        db.leads.push(created);
        db.overview.push(created);
        written.push(created);
        continue;
      }

      if (existing) {
        Object.assign(existing, generated);
        written.push(existing);
        continue;
      }
      const created = withGenerated(table, {
        id: uuid(2000 + db.messages.length),
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: `2026-10-05T09:0${db.messages.length}:00.000Z`,
        parent_message_id: null,
        ...incoming,
      });
      db.messages.push(created);
      written.push(created);
    }
  }

  b.onConflict = () => b;
  b.select = () => b;
  b.maybeSingle = async () => {
    run();
    return { data: written[0] ?? null, error: null };
  };
  b.then = (onFulfilled: (value: unknown) => unknown) => {
    run();
    return Promise.resolve(onFulfilled?.({ data: null, error: null }));
  };

  return b;
}

/** `.update(...)` — the composer's edit path, which must not create a new row. */
function updateBuilder(table: string, patch: Row) {
  const filters: Array<[string, unknown]> = [];
  const b = selectBuilder(table, "");
  void b;
  const u: Record<string, unknown> = {};

  u.eq = (column: string, value: unknown) => {
    filters.push([column, { kind: "eq", value }]);
    return u;
  };
  u.select = () => u;
  u.maybeSingle = async () => {
    const [row] = tableOf(table).filter((existing) =>
      matches(existing, filters),
    );
    if (!row) return { data: null, error: null };
    Object.assign(row, withGenerated(table, { ...row, ...patch }));
    return { data: row, error: null };
  };
  u.then = (onFulfilled: (value: unknown) => unknown) => {
    const affected = tableOf(table).filter((row) => matches(row, filters));
    for (const row of affected)
      Object.assign(row, withGenerated(table, { ...row, ...patch }));
    return Promise.resolve(onFulfilled({ data: affected, error: null }));
  };

  return u;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      return {
        select: (columns?: string) => selectBuilder(table, columns ?? ""),
        upsert: (rows: Row | Row[]) => upsertBuilder(table, rows),
        update: (patch: Row) => updateBuilder(table, patch),
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
      cookieStore.has(name)
        ? { name, value: cookieStore.get(name) }
        : undefined,
  }),
  headers: async () => new Headers(),
}));

/* -------------------------------------------------------------------------- */
/* the batch                                                                   */
/* -------------------------------------------------------------------------- */

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

/** A lead that already exists before the paste. */
/**
 * Deterministic UUID-shaped ids.
 *
 * The shape is not cosmetic: `loadInitialOutreachDetail()` validates the lead and
 * message ids against a real UUID pattern before it will load a draft, because
 * the browser is not allowed to name a message. Fixture ids of `lead-1` would be
 * refused before the query ever ran, and the composer path would go untested.
 */
function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function seedLead(email: string, company: string) {
  const row = withGenerated("leads", {
    id: uuid(1000 + db.leads.length),
    email,
    company_name: company,
    contact_name: null,
    status: "draft",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
  });
  db.leads.push(row);
  db.overview.push(row);
}

/** A row in the imported legacy history — the hard-stop guard. */
function seedHistory(email: string, company: string, lastContacted: string) {
  db.historical.push(
    withGenerated("historical_outreach", {
      id: uuid(3000 + db.historical.length),
      email,
      company,
      domain: email.split("@")[1] ?? "",
      contact_count: 3,
      first_contact_at: "2026-09-01T09:00:00.000Z",
      last_contact_at: lastContacted,
      subjects: "První dotaz || Ještě navazuji || Nabídka",
      source: "historical_import",
    }),
  );
}

/**
 * The operator's ten finished emails, pasted as one block.
 *
 * Chosen to contain, in one paste, every case the feature has to survive:
 *
 *   1  plain, matches an existing lead
 *   2  a `---` INSIDE the body (a table divider) — must not split
 *   3  a `---` inside the body AND a copied mail-client header block
 *   4  an unknown recipient — no lead exists yet, still importable
 *   5  an address in the legacy history — blocked
 *   6  a different address at a legacy company's domain — blocked by the domain guard
 *   7  a repeat of email 1 in different casing — duplicate in paste
 *   8  a block with no recipient at all — needs review
 *   9  Czech labels (`Adresát` / `Předmět`)
 *  10  an address on a shared mailbox provider, unrelated to any history
 *
 * Expectation: 6 ready (1, 2, 3, 4, 9, 10), 2 blocked, 1 duplicate,
 * 1 needs review = 10 blocks, 6 drafts.
 */
const BATCH = `To: info@bistrot.cz
Subject: Váš web a rezervace
Dobrý den,

rád bych vám ukázal, jak lze zjednodušit rezervace na webu.

V týdnu mám volno od 10h, můžeme se spojit telefonicky.

S pozdravem
Petr Novák
jednatel

---

To: info@vinoteka.cz
Subject: Nabídka pro vinotéku
Dobrý den,

posílám krátký přehled, co by pro vaši vinotéku mohlo dávat smysl:

Položky           Doporučená cena
---

Červené víno      290 Kč
Bílé víno         240 Kč

S pozdravem
Petr

---

From: Petr Novák <petr@firma.cz>
Date: Tue, 1 Oct 2026 at 09:12:00 +0200
To: hello@thearchive.cz
Subject: AI recepce pro archiv

Dobrý den,

nabízím AI recepci, která odpovídá na dotazy mimo otevírací hodiny.

---
Doporučené kroky:
1. příprava
2. pilot
3. rozjezd

S pozdravem

---

To: objednavky@firma-co-nem-existuje.cz
Subject: Spolupráce
Dobrý den,

rád bych vám představil naši nabídku.

S pozdravem
Petr

---

To: 100catering@manihi.cz
Subject: Catering na míru
Dobrý den,

rád bych vám ukázal možnosti pro vaše akce.

S pozdravem
Petr

---

To: objednavky@manihi.cz
Subject: Nový ceník
Dobrý den,

posílám vám nový ceník.

S pozdravem
Petr

---

To: INFO@BISTROT.CZ
Subject: Váš web a rezervace
Dobrý den,

to je jen kopie, adresát je stejný.

S pozdravem
Petr

---

Subject: Chybí adresát
Dobrý den,

tento blok nemá řádek To.

S pozdravem
Petr

---

Adresát: rezervace@sklep.cz
Předmět: Večera na míru
Dobrý den,

rád bych vám nabídl večeři pro vaši restauraci.

S pozdravem
Petr

---

To: nekdo.jiny@gmail.com
Subject: AI recepce
Dobrý den,

nabízím AI recepci pro vaši firmu.

S pozdravem
Petr`;

/** Is this exact address present in the table? Rows are `unknown`-typed fixtures. */
function emailOf(rows: Row[], address: string): boolean {
  return rows.some(
    (row) => String(row.email ?? row.recipient_email ?? "") === address,
  );
}

async function authenticate() {
  cookieStore.set(SESSION_COOKIE, createSessionToken());
}

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
  db.leads = [];
  db.messages = [];
  db.historical = [];
  db.overview = [];
  cookieStore.clear();
  mocks.revalidatePath.mockReset();

  // Leads the operator already had before pasting.
  seedLead("info@bistrot.cz", "Bistro U Lva");
  seedLead("info@vinoteka.cz", "Vinotéka Na Půl");
  seedLead("hello@thearchive.cz", "The Archive");
  seedLead("rezervace@sklep.cz", "Sklep");
  seedLead("nekdo.jiny@gmail.com", null as unknown as string);

  // Legacy outreach from the previous business account.
  seedHistory("100catering@manihi.cz", "Manihi", "2026-09-25T08:23:16.000Z");
});

/* -------------------------------------------------------------------------- */
/* the run                                                                     */
/* -------------------------------------------------------------------------- */

describe("Paste Emails — end to end with a realistic batch of ten", () => {
  it("walks PASTE → PARSE → PREVIEW → MATCH → IMPORT → DRAFTS → COMPOSER", async () => {
    await authenticate();
    const { previewBulkEmails, importBulkEmails } =
      await import("@/app/bulk-actions");

    /* ---------------------------------------------------------------- */
    /* 1. Exactly ten email blocks are detected                          */
    /* ---------------------------------------------------------------- */
    const preview = await previewBulkEmails(BATCH);
    if (!preview.ok) throw new Error(preview.error);

    const { plan } = preview;
    expect(plan.summary.total).toBe(10);
    expect(plan.rows).toHaveLength(10);
    expect(plan.rows.map((row) => row.index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);

    /* ---------------------------------------------------------------- */
    /* 5. A `---` inside a body did not split an email                   */
    /* ---------------------------------------------------------------- */
    // Emails 2 and 3 both contain rules in their bodies and are still one
    // block each — ten in, ten out, not twelve.
    expect(plan.splitBy).toBe("recipient_header");
    expect(plan.rows[1]!.body).toContain("Položky           Doporučená cena");
    expect(plan.rows[1]!.body).toContain("---");
    expect(plan.rows[2]!.body).toContain("---");
    expect(plan.rows[2]!.body).toContain("Doporučené kroky:");

    /* ---------------------------------------------------------------- */
    /* 2 and 3. Every recipient and subject is correct                    */
    /* ---------------------------------------------------------------- */
    expect(plan.rows.map((row) => row.recipient)).toEqual([
      "info@bistrot.cz",
      "info@vinoteka.cz",
      "hello@thearchive.cz",
      "objednavky@firma-co-nem-existuje.cz",
      "100catering@manihi.cz",
      "objednavky@manihi.cz",
      "info@bistrot.cz", // the duplicate
      null, // no recipient
      "rezervace@sklep.cz",
      "nekdo.jiny@gmail.com",
    ]);

    expect(plan.rows.map((row) => row.subject)).toEqual([
      "Váš web a rezervace",
      "Nabídka pro vinotéku",
      "AI recepce pro archiv",
      "Spolupráce",
      "Catering na míru",
      "Nový ceník",
      "Váš web a rezervace",
      "Chybí adresát",
      "Večera na míru",
      "AI recepce",
    ]);

    /* ---------------------------------------------------------------- */
    /* 4. Every body is preserved exactly                                */
    /* ---------------------------------------------------------------- */
    expect(plan.rows[0]!.body).toBe(
      "Dobrý den,\n\nrád bych vám ukázal, jak lze zjednodušit rezervace na webu.\n\nV týdnu mám volno od 10h, můžeme se spojit telefonicky.\n\nS pozdravem\nPetr Novák\njednatel",
    );
    // The table in email 2 survives with its alignment intact.
    expect(plan.rows[1]!.body).toContain("Červené víno      290 Kč");
    // Email 3 is a copied mail block: the reply line and the client's headers
    // are not the message, and the body is otherwise verbatim.
    expect(plan.rows[2]!.body).not.toContain("Date:");
    expect(plan.rows[2]!.body).not.toContain("petr@firma.cz");
    expect(plan.rows[2]!.body).toContain(
      "nabízím AI recepci, která odpovídá na dotazy mimo otevírací hodiny.",
    );

    /* ---------------------------------------------------------------- */
    /* 6, 7, 8, 9. The statuses, one per case                             */
    /* ---------------------------------------------------------------- */
    expect(plan.summary.ready).toBe(6);
    expect(plan.summary.alreadyContacted).toBe(2);
    expect(plan.summary.duplicates).toBe(1);
    expect(plan.summary.needsReview).toBe(1);
    expect(plan.summary.importable).toBe(6);

    // 6. Existing leads matched, with their real company names.
    expect(plan.rows[0]!.leadCompany).toBe("Bistro U Lva");
    expect(plan.rows[1]!.leadCompany).toBe("Vinotéka Na Půl");
    expect(plan.rows[8]!.leadCompany).toBe("Sklep");

    // 7. Unknown recipient: still READY. The lead it needs is created on import.
    expect(plan.rows[3]!.status).toBe("ready");
    expect(plan.rows[3]!.reason).toBeNull();
    expect(plan.rows[3]!.leadId).toBeNull();
    expect(plan.rows[3]!.leadCompany).toBeNull();

    // 8. The legacy address, and its domain sibling, are both refused.
    expect(plan.rows[4]!.status).toBe("already_contacted");
    expect(plan.rows[4]!.blockReason).toBe("ALREADY_CONTACTED");
    expect(plan.rows[4]!.reason).toContain("Already contacted");
    expect(plan.rows[4]!.reason).toContain("2026-09-25");
    expect(plan.rows[4]!.contactCount).toBe(3);
    expect(plan.rows[5]!.status).toBe("already_contacted");
    expect(plan.rows[5]!.blockReason).toBe("ALREADY_CONTACTED_DOMAIN");

    // 9. The in-paste duplicate, detected despite different casing.
    expect(plan.rows[6]!.status).toBe("duplicate");
    expect(plan.rows[6]!.duplicateOf).toBe(1);

    // 8 (continued). The block with no recipient.
    expect(plan.rows[7]!.status).toBe("needs_review");
    expect(plan.rows[7]!.recipient).toBeNull();

    // A shared mailbox provider is not a company and blocks nothing.
    expect(plan.rows[9]!.status).toBe("ready");

    /* ---------------------------------------------------------------- */
    /* Nothing was written by the preview                                */
    /* ---------------------------------------------------------------- */
    expect(db.messages).toHaveLength(0);

    /* ---------------------------------------------------------------- */
    /* IMPORT → CREATE DRAFTS                                            */
    /* ---------------------------------------------------------------- */
    const requests = plan.rows
      .filter((row) => row.status === "ready")
      .map((row) => ({
        index: row.index,
        recipient: row.recipient!,
        subject: row.subject,
        body: row.body,
      }));

    const imported = await importBulkEmails(requests);
    if (!imported.ok) throw new Error(imported.error);

    expect(imported.rows).toHaveLength(6);
    expect(imported.rows.every((row) => row.outcome === "created")).toBe(true);
    expect(db.messages).toHaveLength(6);

    // Exactly the six ready recipients became drafts — including the unknown
    // one. No seventh.
    expect(new Set(db.messages.map((m) => m.recipient_email))).toEqual(
      new Set([
        "info@bistrot.cz",
        "info@vinoteka.cz",
        "hello@thearchive.cz",
        "objednavky@firma-co-nem-existuje.cz",
        "rezervace@sklep.cz",
        "nekdo.jiny@gmail.com",
      ]),
    );

    /* ---------------------------------------------------------------- */
    /* 4. Bodies landed byte-identical                                   */
    /* ---------------------------------------------------------------- */
    const stored = (recipient: string) =>
      db.messages.find((m) => m.recipient_email === recipient)!;

    expect(stored("info@bistrot.cz").subject).toBe("Váš web a rezervace");
    expect(stored("info@bistrot.cz").body).toBe(plan.rows[0]!.body);
    expect(stored("info@vinoteka.cz").body).toContain(
      "Položky           Doporučená cena",
    );
    expect(stored("hello@thearchive.cz").body).toBe(plan.rows[2]!.body);
    expect(stored("rezervace@sklep.cz").subject).toBe("Večera na míru");

    /* ---------------------------------------------------------------- */
    /* 7 and 8. A lead for the unknown recipient, none for the blocked */
    /* ---------------------------------------------------------------- */
    // The unknown recipient now has both a lead and a draft. The lead carries
    // no invented company identity — the operator supplied none.
    expect(emailOf(db.leads, "objednavky@firma-co-nem-existuje.cz")).toBe(true);
    expect(emailOf(db.messages, "objednavky@firma-co-nem-existuje.cz")).toBe(
      true,
    );
    const newLead = db.leads.find(
      (l) => l.email === "objednavky@firma-co-nem-existuje.cz",
    )!;
    expect(newLead.company_name).toBeNull();
    expect(newLead.contact_name).toBeNull();

    expect(emailOf(db.messages, "objednavky@manihi.cz")).toBe(false);
    expect(emailOf(db.messages, "100catering@manihi.cz")).toBe(false);
    // And no lead was created for the blocked addresses either.
    expect(emailOf(db.leads, "objednavky@manihi.cz")).toBe(false);
    expect(emailOf(db.leads, "100catering@manihi.cz")).toBe(false);

    /* ---------------------------------------------------------------- */
    /* 11, 12, 13. Nothing sent, no follow-up scheduled                  */
    /* ---------------------------------------------------------------- */
    expect(db.messages.every((m) => m.status === "draft")).toBe(true);
    expect(db.messages.every((m) => m.sent_at === null)).toBe(true);
    expect(db.messages.every((m) => m.sequence_number === 0)).toBe(true);
    expect(db.leads.every((l) => l.last_contacted_at === null)).toBe(true);
    expect(db.leads.every((l) => l.next_followup_at === null)).toBe(true);
    expect(db.leads.every((l) => l.followup_count === 0)).toBe(true);

    /* ---------------------------------------------------------------- */
    /* 10. The drafts appear in the normal history UI                     */
    /* ---------------------------------------------------------------- */
    const { listOutreachHistory } =
      await import("@/lib/services/outreach-service");
    const history = await listOutreachHistory();
    if (!history.ok || !history.data)
      throw new Error(history.error ?? "history failed");

    const historyEmails = new Set(history.data.map((row) => row.email));
    expect(historyEmails.has("info@bistrot.cz")).toBe(true);
    expect(historyEmails.has("hello@thearchive.cz")).toBe(true);
    // The historically blocked recipients are absent from the UI too.
    expect(historyEmails.has("100catering@manihi.cz")).toBe(false);
    expect(historyEmails.has("objednavky@manihi.cz")).toBe(false);

    const histRow = history.data.find(
      (row) => row.email === "info@bistrot.cz",
    )!;
    expect(histRow.latestSubject).toBe("Váš web a rezervace");
    expect(histRow.latestMessageStatus).toBe("draft");
    expect(histRow.messageCount).toBe(1);
    expect(histRow.company_name).toBe("Bistro U Lva");
    // The unknown recipient is in the same history table, as a normal draft.
    expect(historyEmails.has("objednavky@firma-co-nem-existuje.cz")).toBe(true);
    const newHistRow = history.data.find(
      (row) => row.email === "objednavky@firma-co-nem-existuje.cz",
    )!;
    expect(newHistRow.latestSubject).toBe("Spolupráce");
    expect(newHistRow.latestMessageStatus).toBe("draft");
    expect(newHistRow.messageCount).toBe(1);
    expect(newHistRow.company_name).toBeNull();
    // It is a draft in the history table, exactly like one typed in the composer.
    expect(histRow.status).toBe("draft");
    expect(histRow.last_contacted_at).toBeNull();

    /* ---------------------------------------------------------------- */
    /* A READY draft opens in the composer exactly like a normal draft    */
    /* ---------------------------------------------------------------- */
    const messageId = stored("info@bistrot.cz").id as string;
    const { loadInitialOutreachDetail } = await import("@/app/actions");
    const detail = await loadInitialOutreachDetail({ leadId: histRow.id });

    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error(detail.error);

    // The composer opens it as an ordinary initial outreach: same message id,
    // same recipient, subject and body, still an unsent draft.
    expect(detail.detail.message.id).toBe(messageId);
    expect(detail.detail.message.recipient_email).toBe("info@bistrot.cz");
    expect(detail.detail.message.subject).toBe("Váš web a rezervace");
    expect(detail.detail.message.body).toBe(plan.rows[0]!.body);
    expect(detail.detail.message.status).toBe("draft");
    expect(detail.detail.message.sent_at).toBeNull();
    expect(detail.detail.message.sequence_number).toBe(0);
    expect(detail.detail.isInitial).toBe(true);
    expect(detail.detail.lead.company_name).toBe("Bistro U Lva");
    expect(detail.detail.lead.followup_count).toBe(0);

    // And the composer can save over it — the same edit path as a typed draft,
    // which refreshes the same row rather than creating a second one.
    const { saveDraft: editDraft } = await import("@/app/actions");
    const edited = await editDraft({
      messageId,
      recipientEmail: "info@bistrot.cz",
      subject: "Váš web a rezervace (upraveno)",
      body: "Dobrý den,\n\nupravený text.",
    });
    expect(edited.ok).toBe(true);
    expect(db.messages).toHaveLength(6);
    expect(stored("info@bistrot.cz").subject).toBe(
      "Váš web a rezervace (upraveno)",
    );
    expect(stored("info@bistrot.cz").sent_at).toBeNull();

    /* ---------------------------------------------------------------- */
    /* 14. Re-importing the same batch creates no duplicates               */
    /* ---------------------------------------------------------------- */
    const again = await importBulkEmails(requests);
    if (!again.ok) throw new Error(again.error);

    expect(db.messages).toHaveLength(6);
    expect(db.leads).toHaveLength(6);
    expect(new Set(db.messages.map((m) => m.id)).size).toBe(6);
    // The second pass refreshed the same six rows rather than adding six.
    expect(again.rows.every((row) => row.outcome === "already_present")).toBe(
      true,
    );
    expect(db.messages.find((m) => m.id === messageId)!.subject).toBe(
      "Váš web a rezervace",
    );

    /* ---------------------------------------------------------------- */
    /* 15. The single-email flow is untouched                             */
    /* ---------------------------------------------------------------- */
    const { parseBulkEmails } = await import("@/lib/import/bulk-emails");
    const { candidates } = parseBulkEmails(
      "recipient: info@bistrot.cz\nsubject: Ruční test\nbody: Dobrý den, tento text.",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.recipient).toBe("info@bistrot.cz");
    expect(candidates[0]!.subject).toBe("Ruční test");
    expect(candidates[0]!.status).toBe("parsed");

    const { saveDraft } = await import("@/app/actions");
    const manual = await saveDraft({
      recipientEmail: "info@bistrot.cz",
      subject: candidates[0]!.subject!,
      body: candidates[0]!.body!,
    });
    expect(manual.ok).toBe(true);

    // The composer's own save refreshes the same slot-0 draft — no pile-up.
    expect(db.messages).toHaveLength(6);
    expect(stored("info@bistrot.cz").subject).toBe("Ruční test");
  });

  it("refuses the blocked recipients even when the whole batch is posted at once", async () => {
    await authenticate();
    const { importBulkEmails } = await import("@/app/bulk-actions");

    // The operator (or a crafted request) names every recipient from the batch,
    // including the ones the preview refused.
    const result = await importBulkEmails([
      {
        index: 5,
        recipient: "100catering@manihi.cz",
        subject: "Catering na míru",
        body: "text",
      },
      {
        index: 6,
        recipient: "objednavky@manihi.cz",
        subject: "Nový ceník",
        body: "text",
      },
      {
        index: 4,
        recipient: "objednavky@firma-co-nem-existuje.cz",
        subject: "Spolupráce",
        body: "text",
      },
      {
        index: 1,
        recipient: "info@bistrot.cz",
        subject: "Váš web",
        body: "text",
      },
    ]);

    if (!result.ok) throw new Error(result.error);

    // The two allowed addresses get drafts; the two historically blocked ones do
    // not. A missing lead is no longer a reason to refuse.
    expect(result.rows.filter((row) => row.outcome === "created")).toHaveLength(
      2,
    );
    expect(result.rows.filter((row) => row.outcome === "skipped")).toHaveLength(
      2,
    );
    expect(db.messages).toHaveLength(2);
    expect(new Set(db.messages.map((m) => m.recipient_email))).toEqual(
      new Set(["info@bistrot.cz", "objednavky@firma-co-nem-existuje.cz"]),
    );
    // The five leads that already existed, plus one created for the unknown
    // recipient — and none for either blocked address.
    expect(db.leads).toHaveLength(6);
    expect(
      db.leads.some((l) => l.email === "objednavky@firma-co-nem-existuje.cz"),
    ).toBe(true);
    expect(db.leads.some((l) => l.email === "objednavky@manihi.cz")).toBe(
      false,
    );
    expect(db.leads.some((l) => l.email === "100catering@manihi.cz")).toBe(
      false,
    );
  });

  it("does not send anything, even if every send flag is set on the request", async () => {
    await authenticate();
    const { previewBulkEmails, importBulkEmails } =
      await import("@/app/bulk-actions");
    const { recordOutreachSent } = await import("@/app/actions");

    const preview = await previewBulkEmails(BATCH);
    if (!preview.ok) throw new Error(preview.error);
    const ready = preview.plan.rows.filter((row) => row.status === "ready");
    await importBulkEmails(
      ready.map((row) => ({
        index: row.index,
        recipient: row.recipient!,
        subject: row.subject,
        body: row.body,
      })),
    );

    // The bulk path returned message ids. Handing one to the send action is the
    // operator explicitly pressing the button — the import itself did not do it.
    const message = db.messages.find(
      (m) => m.recipient_email === "info@bistrot.cz",
    )!;
    const lead = db.leads.find((l) => l.id === message.lead_id)!;
    expect(message.sent_at).toBeNull();
    expect(lead.followup_count).toBe(0);

    // And the send action refuses a historical contact taken from the same batch.
    const refused = await recordOutreachSent({
      messageId: "does-not-exist",
      leadId: "does-not-exist",
    });
    expect(refused.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the brief's five-email case                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Five emails: three with existing leads, one with none, one in the history.
 *
 * This is the scenario the brief spells out, and it is the one that used to fail:
 * the unknown recipient came back as `no_lead_match` and no draft was made for
 * it. The point of the batch is that a finished email is enough — the operator
 * should not have to open the composer and create a lead first.
 */
const FIVE = `To: info@bistrot.cz
Subject: Váš web a rezervace
Dobrý den,

rád bych vám ukázal, jak lze zjednodušit rezervace na webu.

S pozdravem
Petr

---

To: objednavky@firma-co-nem-existuje.cz
Subject: Spolupráce
Dobrý den,

tuhle firmu vPepě neznáme, ale e-mail je platný a hotový.

S pozdravem
Petr

---

To: hello@thearchive.cz
Subject: AI recepce pro archiv
Dobrý den,

nabízím AI recepci pro vaše muzeum.

S pozdravem
Petr

---

To: 100catering@manihi.cz
Subject: Catering na míru
Dobrý den,

rád bych vám ukázal možnosti pro vaše akce.

S pozdravem
Petr

---

To: rezervace@sklep.cz
Subject: Večera na míru
Dobrý den,

rád bych vám nabídl večeři.

S pozdravem
Petr`;

describe("five emails: three known leads, one unknown, one historical", () => {
  it("creates four drafts, one new lead, and one refusal", async () => {
    await authenticate();
    const { previewBulkEmails, importBulkEmails } =
      await import("@/app/bulk-actions");

    /* ---------------------------------------------------------------- */
    /* PREVIEW: 4 ready, 1 already contacted, 0 no-lead-match             */
    /* ---------------------------------------------------------------- */
    const preview = await previewBulkEmails(FIVE);
    if (!preview.ok) throw new Error(preview.error);

    const { plan } = preview;
    expect(plan.summary.total).toBe(5);
    expect(plan.summary.ready).toBe(4);
    expect(plan.summary.alreadyContacted).toBe(1);
    expect(plan.summary.needsReview).toBe(0);
    expect(plan.summary.duplicates).toBe(0);
    expect(plan.summary.failed).toBe(0);
    // There is no no-lead-match counter any more, because the status is gone.
    expect(plan.summary.importable).toBe(4);

    expect(plan.rows.map((row) => row.status)).toEqual([
      "ready",
      "ready", // the unknown recipient
      "ready",
      "already_contacted",
      "ready",
    ]);

    // Nothing was written by the preview.
    expect(db.leads).toHaveLength(5);
    expect(db.messages).toHaveLength(0);

    /* ---------------------------------------------------------------- */
    /* IMPORT: 4 drafts, 1 new lead, 1 refusal                          */
    /* ---------------------------------------------------------------- */
    const requests = plan.rows
      .filter((row) => row.status === "ready")
      .map((row) => ({
        index: row.index,
        recipient: row.recipient!,
        subject: row.subject,
        body: row.body,
      }));

    const imported = await importBulkEmails(requests);
    if (!imported.ok) throw new Error(imported.error);

    expect(imported.rows).toHaveLength(4);
    expect(imported.rows.every((row) => row.outcome === "created")).toBe(true);
    expect(db.messages).toHaveLength(4);

    // Exactly one new lead: the four pre-existing ones plus the unknown one.
    expect(db.leads).toHaveLength(6);
    const newLead = db.leads.find(
      (l) => l.email === "objednavky@firma-co-nem-existuje.cz",
    );
    expect(newLead).toBeDefined();
    // No company identity was invented for it.
    expect(newLead!.company_name).toBeNull();

    // The historical recipient got nothing — not a draft, not a lead.
    expect(
      db.messages.some((m) => m.recipient_email === "100catering@manihi.cz"),
    ).toBe(false);
    expect(db.leads.some((l) => l.email === "100catering@manihi.cz")).toBe(
      false,
    );

    /* ---------------------------------------------------------------- */
    /* OPEN THE NEW DRAFT FOR THE UNKNOWN RECIPIENT IN THE COMPOSER      */
    /* ---------------------------------------------------------------- */
    const unknownBody = plan.rows[1]!.body!;
    const storedUnknown = db.messages.find(
      (m) => m.recipient_email === "objednavky@firma-co-nem-existuje.cz",
    )!;

    // Byte-identical in the database.
    expect(storedUnknown.subject).toBe(plan.rows[1]!.subject);
    expect(storedUnknown.body).toBe(unknownBody);
    expect(storedUnknown.sequence_number).toBe(0);
    expect(storedUnknown.status).toBe("draft");
    expect(storedUnknown.sent_at).toBeNull();

    // And byte-identical again through the real composer load path.
    const { loadInitialOutreachDetail } = await import("@/app/actions");
    const detail = await loadInitialOutreachDetail({
      leadId: newLead!.id as string,
    });

    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error(detail.error);

    expect(detail.detail.message.id).toBe(storedUnknown.id);
    expect(detail.detail.message.recipient_email).toBe(
      "objednavky@firma-co-nem-existuje.cz",
    );
    expect(detail.detail.message.subject).toBe(plan.rows[1]!.subject);
    expect(detail.detail.message.body).toBe(unknownBody);
    expect(detail.detail.message.status).toBe("draft");
    expect(detail.detail.message.sent_at).toBeNull();
    expect(detail.detail.message.sequence_number).toBe(0);
    expect(detail.detail.isInitial).toBe(true);
    expect(detail.detail.lead.id).toBe(newLead!.id);
    expect(detail.detail.lead.company_name).toBeNull();
    expect(detail.detail.lead.followup_count).toBe(0);

    /* ---------------------------------------------------------------- */
    /* The send flow is available on it — and is NOT taken                */
    /* ---------------------------------------------------------------- */
    // `recordOutreachSent` is the composer's own action; asserting its shape
    // is the point, so nothing here can send an email even by accident.
    const { recordOutreachSent } = await import("@/app/actions");
    expect(typeof recordOutreachSent).toBe("function");

    // Opening the draft did not change its state, and no follow-up exists.
    expect(storedUnknown.sent_at).toBeNull();
    expect(storedUnknown.status).toBe("draft");
    expect(newLead!.last_contacted_at).toBeNull();
    expect(newLead!.followup_count).toBe(0);

    /* ---------------------------------------------------------------- */
    /* IDEMPOTENCY: re-importing makes no second slot-0 draft            */
    /* ---------------------------------------------------------------- */
    const again = await importBulkEmails(requests);
    if (!again.ok) throw new Error(again.error);

    expect(db.messages).toHaveLength(4);
    expect(db.leads).toHaveLength(6);
    expect(again.rows.every((row) => row.outcome === "already_present")).toBe(
      true,
    );
    expect(
      again.rows.find(
        (row) => row.recipient === "objednavky@firma-co-nem-existuje.cz",
      )!.messageId,
    ).toBe(storedUnknown.id);
  });
});

/* -------------------------------------------------------------------------- */
/* the brief's thirty-email case                                               */
/* -------------------------------------------------------------------------- */

/** Thirty finished emails, seven of them on the legacy blocklist. */
function thirtyEmails(): string {
  return Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    // Emails 1–7 sit on the blocked domain; the rest are ordinary unknowns.
    const recipient =
      n <= 7 ? `objednavky${n}@blokovana-firma.cz` : `info@firma${n}.cz`;
    return [
      `To: ${recipient}`,
      `Subject: Nabídka číslo ${n}`,
      `Dobrý den,`,
      ``,
      `text firmy číslo ${n} — původní znění, nedotčené.`,
      ``,
      `S pozdravem`,
      `Petr Novák`,
      `jednatel`,
    ].join("\n");
  }).join("\n\n---\n\n");
}

describe("thirty emails: 7 already contacted, 23 ready", () => {
  it("produces exactly the summary the brief asks for and 23 drafts", async () => {
    // The legacy account pitched the first seven.
    for (let n = 1; n <= 7; n += 1) {
      seedHistory(
        `objednavky${n}@blokovana-firma.cz`,
        `Blokovaná firma ${n}`,
        "2026-09-20T08:00:00.000Z",
      );
    }
    await authenticate();
    const { previewBulkEmails, importBulkEmails } =
      await import("@/app/bulk-actions");
    const { summarizeOutcomes } = await import("@/lib/import/bulk-plan");

    const preview = await previewBulkEmails(thirtyEmails());
    if (!preview.ok) throw new Error(preview.error);

    const { plan } = preview;

    // DETECTED: 30 EMAILS / 23 READY / 7 ALREADY CONTACTED / 0 NEEDS REVIEW /
    // 0 DUPLICATE — and no no-lead-match line at all.
    expect(plan.summary.total).toBe(30);
    expect(plan.summary.ready).toBe(23);
    expect(plan.summary.alreadyContacted).toBe(7);
    expect(plan.summary.needsReview).toBe(0);
    expect(plan.summary.duplicates).toBe(0);
    expect(plan.summary.failed).toBe(0);
    expect(plan.summary.importable).toBe(23);

    // None of the thirty was blocked for lacking a lead.
    expect(plan.rows.filter((row) => row.status === "ready")).toHaveLength(23);
    expect(
      plan.rows.every(
        (row) => row.reason === null || row.status === "already_contacted",
      ),
    ).toBe(true);

    // Twenty-three leads exist; the twenty-three unknown recipients do not.
    expect(db.leads).toHaveLength(5);
    expect(db.messages).toHaveLength(0);

    /* ---------------------------------------------------------------- */
    /* CREATE 23 DRAFTS                                                   */
    /* ---------------------------------------------------------------- */
    const requests = plan.rows
      .filter((row) => row.status === "ready")
      .map((row) => ({
        index: row.index,
        recipient: row.recipient!,
        subject: row.subject,
        body: row.body,
      }));

    // The client chunks in tens; the server caps at three chunks per request.
    const totals = { created: 0, alreadyPresent: 0, skipped: 0, failed: 0 };
    const ids = new Set<string>();
    for (let i = 0; i < requests.length; i += BULK_IMPORT_CHUNK_SIZE) {
      const chunk = requests.slice(i, i + BULK_IMPORT_CHUNK_SIZE);
      const result = await importBulkEmails(chunk);
      if (!result.ok) throw new Error(result.error);
      const t = summarizeOutcomes(result.rows);
      totals.created += t.ready;
      totals.alreadyPresent += t.alreadyPresent;
      totals.skipped += t.skipped;
      totals.failed += t.failed;
      for (const row of result.rows) if (row.messageId) ids.add(row.messageId);
    }

    expect(totals).toEqual({
      created: 23,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(ids.size).toBe(23);

    // Every ready recipient became its own lead and its own slot-0 draft.
    expect(db.leads).toHaveLength(28);
    expect(db.messages).toHaveLength(23);
    expect(new Set(db.messages.map((m) => m.lead_id)).size).toBe(23);
    expect(new Set(db.messages.map((m) => m.recipient_email))).toEqual(
      new Set(
        plan.rows.filter((r) => r.status === "ready").map((r) => r.recipient),
      ),
    );

    // The seven blocked recipients exist nowhere.
    for (let n = 1; n <= 7; n += 1) {
      const address = `objednavky${n}@blokovana-firma.cz`;
      expect(db.messages.some((m) => m.recipient_email === address)).toBe(
        false,
      );
      expect(db.leads.some((l) => l.email === address)).toBe(false);
    }

    // Every draft is an ordinary unsent slot-0 draft, with its own text intact.
    expect(db.messages.every((m) => m.status === "draft")).toBe(true);
    expect(db.messages.every((m) => m.sent_at === null)).toBe(true);
    expect(db.messages.every((m) => m.sequence_number === 0)).toBe(true);
    for (const m of db.messages) {
      const row = plan.rows.find((r) => r.recipient === m.recipient_email)!;
      expect(m.subject).toBe(row.subject);
      expect(m.body).toBe(row.body);
      expect(String(m.body)).toContain(
        `text firmy číslo ${row.index} — původní znění, nedotčené.`,
      );
    }

    // No lead gained an invented company name, and nothing was contacted.
    expect(
      db.leads
        .filter((l) => String(l.email).startsWith("info@firma"))
        .every((l) => l.company_name === null),
    ).toBe(true);
    expect(db.leads.every((l) => l.last_contacted_at === null)).toBe(true);
    expect(db.leads.every((l) => l.next_followup_at === null)).toBe(true);
    expect(db.leads.every((l) => l.followup_count === 0)).toBe(true);

    /* ---------------------------------------------------------------- */
    /* Re-running the whole batch refreshes all 23                       */
    /* ---------------------------------------------------------------- */
    for (let i = 0; i < requests.length; i += BULK_IMPORT_CHUNK_SIZE) {
      const result = await importBulkEmails(
        requests.slice(i, i + BULK_IMPORT_CHUNK_SIZE),
      );
      if (!result.ok) throw new Error(result.error);
      expect(summarizeOutcomes(result.rows).alreadyPresent).toBe(
        Math.min(BULK_IMPORT_CHUNK_SIZE, requests.length - i),
      );
    }

    expect(db.messages).toHaveLength(23);
    expect(db.leads).toHaveLength(28);
  });
});

/* -------------------------------------------------------------------------- */
/* canonical LEAD-BLOCK batch — the production path                           */
/* -------------------------------------------------------------------------- */

/**
 * The canonical §11 fixture, verbatim — the SAME text the unit suite runs
 * (`bulk-emails.test.ts`, "canonical LEAD-BLOCK specification"). The spec's
 * acceptance rule is that identical input produces identical results in the
 * parser's unit tests and in the real bulk-import flow the UI calls, so both
 * files keep this exact copy; change one, change both.
 */
const CANONICAL_LEADS = `--- LEAD 01 ---
Company: Test Barber Praha
Website: https://example.com
Email: barber@example.com
Phone: +420700000001
City: Praha 7
Category: Barbershop
Address: Praha 7

Subject: Nabídka pro Test Barber Praha

Dobrý den,

toto je hlavní email.

Follow-up Subject: Re: Nabídka pro Test Barber Praha

Follow-up Body:

Dobrý den,

toto je první follow-up.

Follow-up 2 Subject: Re: Nabídka pro Test Barber Praha

Follow-up 2 Body:

Dobrý den,

toto je druhý follow-up.


--- LEAD 02 ---
Company: Test Salon Praha
Website: https://example.org
Email: salon@example.com
Phone: +420700000002
City: Praha 6
Category: Salon
Address: Praha 6

Subject: Nabídka pro Test Salon Praha

Dobrý den,

toto je hlavní email druhého leadu.

Follow-up Subject: Re: Nabídka pro Test Salon Praha

Follow-up Body:

Dobrý den,

toto je první follow-up druhého leadu.`;

describe("canonical LEAD-BLOCK batch — preview and import through the production path", () => {
  it("parses the fixture exactly like parseBulkEmails and imports drafts with follow-ups", async () => {
    await authenticate();
    const { previewBulkEmails, importBulkEmails } =
      await import("@/app/bulk-actions");
    const { parseBulkEmails } = await import("@/lib/import/bulk-emails");

    // PARITY: the production flow reads the fixture exactly like the unit test.
    const unit = parseBulkEmails(CANONICAL_LEADS);
    const preview = await previewBulkEmails(CANONICAL_LEADS);
    if (!preview.ok) throw new Error(preview.error);
    const { plan } = preview;

    expect(plan.summary.total).toBe(2); // = the two LEAD markers
    expect(plan.splitBy).toBe(unit.splitBy);
    expect(plan.rows).toHaveLength(unit.candidates.length);
    expect(plan.rows.map((row) => row.recipient)).toEqual(
      unit.candidates.map((candidate) => candidate.recipient),
    );
    expect(plan.rows.map((row) => row.subject)).toEqual(
      unit.candidates.map((candidate) => candidate.subject),
    );
    expect(plan.rows.map((row) => row.body)).toEqual(
      unit.candidates.map((candidate) => candidate.body),
    );
    expect(plan.rows.map((row) => row.followUps)).toEqual(
      unit.candidates.map((candidate) => candidate.followUps),
    );

    // The preview table shows two ready rows, free of metadata labels.
    for (const row of plan.rows) {
      expect(row.status).toBe("ready");
      for (const key of [
        "Company:",
        "Website:",
        "Email:",
        "Phone:",
        "City:",
        "Category:",
        "Address:",
      ]) {
        expect(row.body).not.toContain(key);
      }
      expect(String(row.body)).not.toContain("Follow-up");
    }

    // IMPORT: drafts for both leads, follow-ups carried as sequences 1..N.
    const requests = plan.rows
      .filter((row) => row.status === "ready")
      .map((row) => ({
        index: row.index,
        recipient: row.recipient!,
        subject: row.subject,
        body: row.body,
        followUps: row.followUps,
      }));
    const result = await importBulkEmails(requests);
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.every((row) => row.outcome === "created")).toBe(true);

    const messagesFor = (email: string) =>
      db.messages
        .filter((m) => m.recipient_email === email)
        .sort((a, b) => Number(a.sequence_number) - Number(b.sequence_number));

    const barber = messagesFor("barber@example.com");
    expect(barber.map((m) => m.sequence_number)).toEqual([0, 1, 2]);
    expect(barber[0]!.subject).toBe("Nabídka pro Test Barber Praha");
    expect(barber[0]!.body).toBe("Dobrý den,\n\ntoto je hlavní email.");
    expect(barber[1]!.subject).toBe("Re: Nabídka pro Test Barber Praha");
    expect(barber[1]!.body).toBe("Dobrý den,\n\ntoto je první follow-up.");
    expect(barber[2]!.body).toBe("Dobrý den,\n\ntoto je druhý follow-up.");

    const salon = messagesFor("salon@example.com");
    expect(salon.map((m) => m.sequence_number)).toEqual([0, 1]);
    expect(salon[0]!.body).toBe(
      "Dobrý den,\n\ntoto je hlavní email druhého leadu.",
    );
    expect(salon[1]!.body).toBe(
      "Dobrý den,\n\ntoto je první follow-up druhého leadu.",
    );

    // Import wrote nothing but drafts, and nothing was contacted.
    expect(db.messages.every((m) => m.status === "draft")).toBe(true);
    expect(db.messages.every((m) => m.sent_at === null)).toBe(true);
    expect(db.leads.every((l) => l.last_contacted_at === null)).toBe(true);
    expect(db.leads.every((l) => l.followup_count === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* reported production fixture — the exact text pasted in the bug report      */
/* -------------------------------------------------------------------------- */

/**
 * The EXACT input from the "URGENT DEBUG" report, reproduced verbatim —
 * including the blank lines after each marker. The report observed this paste
 * arriving in the composer as ONE merged lead (both recipients space-joined,
 * both subjects concatenated, metadata and `Follow-up …` labels in the body).
 * This suite proves the real production path (the server action behind the
 * Paste Emails preview, the client's request converters, and the import) keeps
 * it as two separate leads, and fails if any boundary ever merges them.
 */
const REPORTED_TWO_LEAD_BATCH = `--- LEAD 01 ---

Company: The Original Barber ŠESTKA
Website: https://www.originalbarbersestka.cz/
Email: originalbarbersestka@gmail.com
Phone: +420 773 150 194
City: Praha 6
Category: Barbershop
Address: Fajtlova 1090/1, Praha 6

Subject: Nabídka pro The Original Barber ŠESTKA

Dobrý den,

narazil jsem na The Original Barber ŠESTKA a rád bych vám ukázal, jak by vám AI recepce mohla pomoct s obsluhou zákazníků a rezervacemi.

Pokud by vás to zaujalo, rád krátce vysvětlím, jak by to mohlo fungovat právě u vás.

Follow-up Subject: Re: Nabídka pro The Original Barber ŠESTKA

Follow-up Body:

Dobrý den,

jen se krátce vracím k předchozímu e-mailu ohledně AI recepce pro váš barbershop.

Pokud vás to zaujalo, můžu vám ukázat konkrétní příklad během pár minut.

Follow-up 2 Subject: Re: Nabídka pro The Original Barber ŠESTKA

Follow-up 2 Body:

Dobrý den,

poslední krátké připomenutí — pokud by vás možnost automatizace komunikace se zákazníky zajímala, rád vám ukážu, jak by to mohlo fungovat přímo u vás.

--- LEAD 02 ---

Company: Glow Up Barber Shop Praha
Website: https://www.glowupbarbershop.cz/
Email: glowupbarbershop@seznam.cz
Phone: +420 775 155 195
City: Praha 7
Category: Barbershop
Address: Dukelských hrdinů 573/30, Praha 7 – Holešovice

Subject: Nabídka pro Glow Up Barber Shop

Dobrý den,

narazil jsem na váš barbershop v Holešovicích a chtěl bych vám ukázat možnost, jak pomocí AI automatizovat část komunikace se zákazníky.

Pokud by vás to zaujalo, rád vám ukážu, jak by to mohlo fungovat přímo u vás.

Follow-up Subject: Re: Nabídka pro Glow Up Barber Shop

Follow-up Body:

Dobrý den,

jen navazuji na svůj předchozí e-mail.

Pokud by vás AI recepce zajímala, rád vám během pár minut ukážu konkrétní využití pro váš barbershop.`;

describe("reported fixture — 2 LEAD blocks stay 2 leads through the production path", () => {
  it("never merges: parse → preview → client requests → import → 5 drafts", async () => {
    await authenticate();
    const { parseBulkEmails } = await import("@/lib/import/bulk-emails");
    const { previewBulkEmails } = await import("@/app/bulk-actions");
    const { importableRequests, BULK_IMPORT_CHUNK_SIZE } =
      await import("@/lib/import/bulk-plan");
    // `importInChunks` is the client's own chunk walker; it calls the
    // `importBulkEmails` server action exactly as the Import button does.
    const { importInChunks } = await import("@/components/bulk-import");

    /* ---------------------------------------------------------------- */
    /* 1. textarea value → parseBulkEmails(): exactly 2 candidates       */
    /* ---------------------------------------------------------------- */
    const parsed = parseBulkEmails(REPORTED_TWO_LEAD_BATCH);

    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]!.recipient).toBe(
      "originalbarbersestka@gmail.com",
    );
    expect(parsed.candidates[1]!.recipient).toBe("glowupbarbershop@seznam.cz");
    expect(parsed.candidates[0]!.subject).toBe(
      "Nabídka pro The Original Barber ŠESTKA",
    );
    expect(parsed.candidates[1]!.subject).toBe(
      "Nabídka pro Glow Up Barber Shop",
    );
    expect(parsed.candidates[0]!.body).toBe(
      "Dobrý den,\n\nnarazil jsem na The Original Barber ŠESTKA a rád bych vám ukázal, jak by vám AI recepce mohla pomoct s obsluhou zákazníků a rezervacemi.\n\nPokud by vás to zaujalo, rád krátce vysvětlím, jak by to mohlo fungovat právě u vás.",
    );
    expect(parsed.candidates[1]!.body).toBe(
      "Dobrý den,\n\nnarazil jsem na váš barbershop v Holešovicích a chtěl bych vám ukázat možnost, jak pomocí AI automatizovat část komunikace se zákazníky.\n\nPokud by vás to zaujalo, rád vám ukážu, jak by to mohlo fungovat přímo u vás.",
    );
    expect(parsed.candidates[0]!.followUps).toHaveLength(2);
    expect(parsed.candidates[1]!.followUps).toHaveLength(1);
    expect(parsed.candidates[0]!.followUps!.map((fu) => fu.subject)).toEqual([
      "Re: Nabídka pro The Original Barber ŠESTKA",
      "Re: Nabídka pro The Original Barber ŠESTKA",
    ]);
    expect(parsed.candidates[0]!.followUps![0]!.body).toBe(
      "Dobrý den,\n\njen se krátce vracím k předchozímu e-mailu ohledně AI recepce pro váš barbershop.\n\nPokud vás to zaujalo, můžu vám ukázat konkrétní příklad během pár minut.",
    );
    expect(parsed.candidates[0]!.followUps![1]!.body).toBe(
      "Dobrý den,\n\nposlední krátké připomenutí — pokud by vás možnost automatizace komunikace se zákazníky zajímala, rád vám ukážu, jak by to mohlo fungovat přímo u vás.",
    );
    expect(parsed.candidates[1]!.followUps![0]!.subject).toBe(
      "Re: Nabídka pro Glow Up Barber Shop",
    );
    expect(parsed.candidates[1]!.followUps![0]!.body).toBe(
      "Dobrý den,\n\njen navazuji na svůj předchozí e-mail.\n\nPokud by vás AI recepce zajímala, rád vám během pár minut ukážu konkrétní využití pro váš barbershop.",
    );
    // The merge signatures from the bug report must never appear.
    for (const candidate of parsed.candidates) {
      expect(candidate.recipient).not.toMatch(/\s/);
      for (const label of [
        "Phone:",
        "City:",
        "Category:",
        "Address:",
        "Company:",
        "Website:",
        "Follow-up",
        "LEAD",
      ]) {
        expect(candidate.body).not.toContain(label);
      }
    }

    /* ---------------------------------------------------------------- */
    /* 2. previewBulkEmails (the Preview button's server action): 2 rows */
    /* ---------------------------------------------------------------- */
    const preview = await previewBulkEmails(REPORTED_TWO_LEAD_BATCH);
    if (!preview.ok) throw new Error(preview.error);
    const { plan } = preview;

    expect(plan.summary.total).toBe(2);
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.map((row) => row.recipient)).toEqual([
      "originalbarbersestka@gmail.com",
      "glowupbarbershop@seznam.cz",
    ]);
    expect(plan.rows.map((row) => row.subject)).toEqual([
      "Nabídka pro The Original Barber ŠESTKA",
      "Nabídka pro Glow Up Barber Shop",
    ]);
    expect(plan.rows.map((row) => row.body)).toEqual(
      parsed.candidates.map((candidate) => candidate.body),
    );
    expect(plan.rows.map((row) => row.followUps)).toEqual(
      parsed.candidates.map((candidate) => candidate.followUps),
    );
    expect(plan.rows.every((row) => row.status === "ready")).toBe(true);

    /* ---------------------------------------------------------------- */
    /* 3. the client's own converters keep the rows separate             */
    /*    (`importableRequests` is exactly what bulk-import.tsx calls    */
    /*    before handing the list to importInChunks)                     */
    /* ---------------------------------------------------------------- */
    const requests = importableRequests(plan);

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.recipient)).toEqual([
      "originalbarbersestka@gmail.com",
      "glowupbarbershop@seznam.cz",
    ]);
    expect(requests.map((request) => request.followUps?.length ?? 0)).toEqual([
      2, 1,
    ]);
    // The exact bug-report signature: a space-joined recipient. Never.
    expect(requests.some((request) => /\s/.test(request.recipient))).toBe(
      false,
    );
    expect(
      requests.some((request) =>
        (request.subject ?? "").includes(
          "Nabídka pro The Original Barber ŠESTKA Nabídka",
        ),
      ),
    ).toBe(false);

    /* ---------------------------------------------------------------- */
    /* 4. client chunk walker → importBulkEmails (server, re-checked)    */
    /* ---------------------------------------------------------------- */
    const resultRows = await importInChunks(
      requests,
      () => {},
      BULK_IMPORT_CHUNK_SIZE,
    );

    expect(resultRows).toHaveLength(2);
    expect(resultRows.every((row) => row.outcome === "created")).toBe(true);

    /* ---------------------------------------------------------------- */
    /* 5. the database: lead 1 → sequences [0,1,2], lead 2 → [0,1]       */
    /*    = 5 drafts, each holding its own lead's text                   */
    /* ---------------------------------------------------------------- */
    expect(db.messages).toHaveLength(5);

    const messagesFor = (email: string) =>
      db.messages
        .filter((m) => m.recipient_email === email)
        .sort((a, b) => Number(a.sequence_number) - Number(b.sequence_number));

    const barber = messagesFor("originalbarbersestka@gmail.com");
    expect(barber.map((m) => m.sequence_number)).toEqual([0, 1, 2]);
    expect(barber.map((m) => m.subject)).toEqual([
      "Nabídka pro The Original Barber ŠESTKA",
      "Re: Nabídka pro The Original Barber ŠESTKA",
      "Re: Nabídka pro The Original Barber ŠESTKA",
    ]);
    expect(barber[0]!.body).toBe(parsed.candidates[0]!.body);
    expect(barber[1]!.body).toBe(parsed.candidates[0]!.followUps![0]!.body);
    expect(barber[2]!.body).toBe(parsed.candidates[0]!.followUps![1]!.body);
    expect(barber[1]!.parent_message_id).toBe(barber[0]!.id);
    expect(barber[2]!.parent_message_id).toBe(barber[0]!.id);

    const glowup = messagesFor("glowupbarbershop@seznam.cz");
    expect(glowup.map((m) => m.sequence_number)).toEqual([0, 1]);
    expect(glowup[0]!.subject).toBe("Nabídka pro Glow Up Barber Shop");
    expect(glowup[0]!.body).toBe(parsed.candidates[1]!.body);
    expect(glowup[1]!.subject).toBe("Re: Nabídka pro Glow Up Barber Shop");
    expect(glowup[1]!.body).toBe(parsed.candidates[1]!.followUps![0]!.body);
    expect(glowup[1]!.parent_message_id).toBe(glowup[0]!.id);

    // No stored row anywhere carries the merged signature, and nothing sent.
    expect(
      db.messages.every((m) => !/\s/.test(String(m.recipient_email))),
    ).toBe(true);
    expect(
      db.messages.every((m) => m.status === "draft" && m.sent_at === null),
    ).toBe(true);
    // The five seeded leads plus exactly one new lead per imported LEAD block.
    expect(db.leads).toHaveLength(7);
    expect(
      db.leads.filter((l) =>
        [
          "originalbarbersestka@gmail.com",
          "glowupbarbershop@seznam.cz",
        ].includes(String(l.email)),
      ),
    ).toHaveLength(2);
  });
});
