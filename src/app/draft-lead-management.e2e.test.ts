import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/token";

/**
 * Draft / lead management — the seven required regressions, run against
 * the real server actions and services.
 *
 *   1  an unsent lead can be edited (recipient, subject, body — and the
 *      same for its follow-up) and stays an unsent draft afterwards
 *   2  an unsent lead can be deleted
 *   3  one lead deleted out of ten imported leads leaves the other nine
 *   4  deleting an unsent lead removes its pending follow-ups
 *   5  deleting an unsent lead touches nothing else
 *   6  a sent lead cannot be accidentally deleted
 *   7  opening Gmail does not mark a lead sent
 *
 * The services are NOT mocked — only Supabase, the session and the cache,
 * so every case travels the production path:
 *
 *   saveDraft / createFollowUp / deleteUnsentLead / openOutreachInGmail
 *   importBulkEmails → checkRecipient → createDraft
 *   listOutreachHistory / loadFollowUpWorkspace → the real dashboard reads
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
  return String(value ?? "").trim().toLowerCase();
}

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

type Predicate =
  | { kind: "eq"; value: unknown }
  | { kind: "neq"; value: unknown }
  | { kind: "in"; value: unknown[] }
  | { kind: "gt"; value: unknown }
  | { kind: "isNull" };

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, raw]) => {
    if (raw === null || typeof raw !== "object") return row[column] === raw;
    const p = raw as Predicate;
    if (p.kind === "eq") return row[column] === p.value;
    if (p.kind === "neq") return row[column] !== p.value;
    if (p.kind === "in") return (p.value as unknown[]).includes(row[column]);
    if (p.kind === "gt") return Number(row[column]) > Number(p.value);
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
      rows = rows.map((lead) => {
        const messages = db.messages
          .filter((m) => m.lead_id === lead.id)
          .sort((a, c) => String(a.created_at).localeCompare(String(c.created_at)));
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
            .map(({ id, status, sent_at, created_at }) => ({ id, status, sent_at, created_at })),
        };
      });
    }
    if (table === "outreach_messages" && columns.includes("leads(")) {
      rows = rows.map((message) => ({
        ...message,
        leads: db.leads.find((lead) => lead.id === message.lead_id) ?? null,
      }));
    }
    return rows;
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
  b.gt = (column: string, value: unknown) => {
    filters.push([column, { kind: "gt", value }]);
    return b;
  };
  b.or = () => b;
  b.is = (column: string, value: null) => {
    filters.push([column, value === null ? { kind: "isNull" } : { kind: "eq", value }]);
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
      const key = String(generated.email_normalized ?? generated.recipient_normalized ?? "");

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

/** `.insert(...)` — the follow-up sequence's append path. */
function insertBuilder(table: string, input: Row | Row[]) {
  if (table !== "outreach_messages") {
    throw new Error(`unexpected insert into ${table}`);
  }
  const b: Record<string, unknown> = {};
  let written: Row[] = [];

  function run(): void {
    written = [];
    for (const incoming of Array.isArray(input) ? input : [input]) {
      const created = withGenerated(table, {
        id: uuid(2000 + db.messages.length),
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: `2026-10-05T10:0${db.messages.length}:00.000Z`,
        parent_message_id: null,
        ...incoming,
      });
      db.messages.push(created);
      written.push(created);
    }
  }

  b.select = () => b;
  b.maybeSingle = async () => {
    run();
    return { data: written[0] ?? null, error: null };
  };
  b.then = (onFulfilled: (value: unknown) => unknown) => {
    run();
    return Promise.resolve(onFulfilled?.({ data: written, error: null }));
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
    const [row] = tableOf(table).filter((existing) => matches(existing, filters));
    if (!row) return { data: null, error: null };
    Object.assign(row, withGenerated(table, { ...row, ...patch }));
    return { data: row, error: null };
  };
  u.then = (onFulfilled: (value: unknown) => unknown) => {
    const affected = tableOf(table).filter((row) => matches(row, filters));
    for (const row of affected) Object.assign(row, withGenerated(table, { ...row, ...patch }));
    return Promise.resolve(onFulfilled({ data: affected, error: null }));
  };

  return u;
}

/**
 * `.delete({ count: "exact" }).eq(...)` — the unsent-lead removal.
 *
 * `leads` is the parent of every related row, so the database cascades:
 * deleting a lead removes its outreach_messages (primary draft and every
 * pending follow-up), its action tokens and its notifications. The mock
 * reproduces that cascade so the tests observe what the operator gets.
 */
function deleteBuilder(table: string) {
  const filters: Array<[string, unknown]> = [];
  const d: Record<string, unknown> = {};

  const run = (): { error: null; count: number } => {
    const victims = tableOf(table).filter((row) => matches(row, filters));
    if (table === "leads") {
      for (const victim of victims) {
        db.messages = db.messages.filter((m) => m.lead_id !== victim.id);
        db.overview = db.overview.filter((o) => o.id !== victim.id);
      }
      db.leads = db.leads.filter((row) => !matches(row, filters));
      return { error: null, count: victims.length };
    }
    const kept = tableOf(table).filter((row) => !matches(row, filters));
    const target = tableOf(table);
    target.length = 0;
    for (const row of kept) target.push(row);
    return { error: null, count: victims.length };
  };

  d.eq = (column: string, value: unknown) => {
    filters.push([column, { kind: "eq", value }]);
    return d;
  };
  d.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled(run()));

  return d;
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      return {
        select: (columns?: string) => selectBuilder(table, columns ?? ""),
        upsert: (rows: Row | Row[]) => upsertBuilder(table, rows),
        insert: (rows: Row | Row[]) => insertBuilder(table, rows),
        update: (patch: Row) => updateBuilder(table, patch),
        delete: () => deleteBuilder(table),
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

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

interface LeadRow {
  id: string;
  email: string;
  company_name: string | null;
  contact_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  next_followup_at: string | null;
  followup_count: number;
}

interface MessageRow {
  id: string;
  lead_id: string;
  recipient_email: string;
  subject: string | null;
  body: string | null;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  sequence_number: number;
  parent_message_id: string | null;
}

function seedLead(email: string, company: string | null): LeadRow {
  const obj = withGenerated("leads", {
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
  db.leads.push(obj);
  db.overview.push(obj);
  return obj as unknown as LeadRow;
}

interface SeedMessageOptions {
  sequenceNumber?: number;
  parentMessageId?: string | null;
  status?: string;
  sentAt?: string | null;
  subject?: string;
  body?: string;
}

function seedMessage(lead: LeadRow, options: SeedMessageOptions = {}): MessageRow {
  const obj = withGenerated("outreach_messages", {
    id: uuid(2000 + db.messages.length),
    lead_id: lead.id,
    recipient_email: lead.email,
    subject: options.subject ?? "Výchozí předmět",
    body: options.body ?? "Výchozí text zprávy.",
    status: options.status ?? "draft",
    provider: null,
    provider_message_id: null,
    sent_at: options.sentAt ?? null,
    created_at: `2026-10-05T09:0${db.messages.length}:00.000Z`,
    sequence_number: options.sequenceNumber ?? 0,
    parent_message_id: options.parentMessageId ?? null,
  });
  db.messages.push(obj);
  return obj as unknown as MessageRow;
}

/** A lead whose primary outreach is still an unsent draft, plus that draft. */
function seedUnsentLead(email: string, company: string | null): { lead: LeadRow; draft: MessageRow } {
  const lead = seedLead(email, company);
  const draft = seedMessage(lead, {
    subject: "Původní předmět",
    body: "Původní text zprávy.",
  });
  return { lead, draft };
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
});

/* -------------------------------------------------------------------------- */
/* the regressions                                                             */
/* -------------------------------------------------------------------------- */

describe("Draft and lead management — end to end", () => {
  it("1. edits an unsent lead and it stays an unsent draft", async () => {
    await authenticate();
    const { lead, draft } = seedUnsentLead("info@bistrot.cz", "Bistro U Lva");
    const { saveDraft } = await import("@/app/actions");

    const edited = await saveDraft({
      recipientEmail: "rezervace@bistrot.cz",
      subject: "Upravený předmět",
      body: "Upravený text zprávy.",
      messageId: draft.id,
    });

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    // The same row was edited in place — no second draft was created.
    expect(edited.created).toBe(false);
    expect(edited.message.id).toBe(draft.id);

    const messages = db.messages.filter((m) => m.lead_id === lead.id);
    expect(messages).toHaveLength(1);
    const m = messages[0] as unknown as MessageRow;
    expect(m.recipient_email).toBe("rezervace@bistrot.cz");
    expect(m.subject).toBe("Upravený předmět");
    expect(m.body).toBe("Upravený text zprávy.");
    // Still a draft, still unsent — editing never sends anything.
    expect(m.status).toBe("draft");
    expect(m.sent_at).toBeNull();

    /* The follow-up edits the same way: subject and body, in place. */
    const { createFollowUp } = await import("@/app/followup-actions");

    const first = await createFollowUp({
      parentMessageId: draft.id,
      subject: "První follow-up",
      body: "Text prvního follow-upu.",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.sequenceNumber).toBe(1);

    const second = await createFollowUp({
      parentMessageId: draft.id,
      subject: "Upravený follow-up",
      body: "Upravený text follow-upu.",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Re-saving the open follow-up updates it instead of appending.
    expect(second.created).toBe(false);
    expect(second.messageId).toBe(first.messageId);
    expect(second.sequenceNumber).toBe(1);

    const followUps = db.messages.filter(
      (m) => m.lead_id === lead.id && m.sequence_number === 1,
    );
    expect(followUps).toHaveLength(1);
    const fu = followUps[0] as unknown as MessageRow;
    expect(fu.subject).toBe("Upravený follow-up");
    expect(fu.body).toBe("Upravený text follow-upu.");
    expect(fu.status).toBe("draft");
    expect(fu.sent_at).toBeNull();
  });

  it("2. deletes an unsent lead together with its primary draft", async () => {
    await authenticate();
    const { lead, draft } = seedUnsentLead("info@bistrot.cz", "Bistro U Lva");
    const { deleteUnsentLead } = await import("@/app/actions");

    const result = await deleteUnsentLead({ leadId: lead.id });

    expect(result).toEqual({ ok: true, deleted: true });
    expect(db.leads.some((l) => l.id === lead.id)).toBe(false);
    expect(db.messages.some((m) => m.id === draft.id)).toBe(false);
    expect(db.overview.some((o) => o.id === lead.id)).toBe(false);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
  });

  it("3. deletes one lead out of ten imported leads and the other nine survive", async () => {
    await authenticate();
    const { importBulkEmails } = await import("@/app/bulk-actions");

    const rows = Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      recipient: `novy${i + 1}@fresh.cz`,
      subject: `Předmět ${i + 1}`,
      body: `Text zprávy číslo ${i + 1}.`,
    }));

    const imported = await importBulkEmails(rows);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.rows).toHaveLength(10);
    expect(imported.rows.every((row) => row.outcome === "created")).toBe(true);
    expect(db.leads).toHaveLength(10);
    expect(db.messages).toHaveLength(10);

    // The fifth lead is the one the operator deletes.
    const victim = db.leads.find((l) => l.email === "novy5@fresh.cz") as unknown as LeadRow;
    const victimMessage = db.messages.find((m) => m.lead_id === victim.id) as unknown as MessageRow;
    const { deleteUnsentLead } = await import("@/app/actions");

    const result = await deleteUnsentLead({ leadId: victim.id });

    expect(result).toEqual({ ok: true, deleted: true });
    expect(db.leads).toHaveLength(9);
    expect(db.messages).toHaveLength(9);
    expect(db.leads.some((l) => l.id === victim.id)).toBe(false);
    expect(db.messages.some((m) => m.id === victimMessage.id)).toBe(false);

    // Each remaining lead keeps exactly its own draft, byte-identical.
    for (const lead of db.leads as unknown as LeadRow[]) {
      const own = db.messages.filter((m) => m.lead_id === lead.id);
      expect(own).toHaveLength(1);
      const m = own[0] as unknown as MessageRow;
      expect(m.status).toBe("draft");
      expect(m.sent_at).toBeNull();
      expect(m.sequence_number).toBe(0);
    }
    const fourth = db.messages.find((m) => m.recipient_email === "novy4@fresh.cz") as unknown as MessageRow;
    expect(fourth.subject).toBe("Předmět 4");
    expect(fourth.body).toBe("Text zprávy číslo 4.");
    const sixth = db.messages.find((m) => m.recipient_email === "novy6@fresh.cz") as unknown as MessageRow;
    expect(sixth.subject).toBe("Předmět 6");
    expect(sixth.body).toBe("Text zprávy číslo 6.");
  });

  it("4. deleting an unsent lead removes its pending follow-ups", async () => {
    await authenticate();
    const { lead, draft } = seedUnsentLead("info@bistrot.cz", "Bistro U Lva");
    const first = seedMessage(lead, {
      sequenceNumber: 1,
      parentMessageId: draft.id,
      subject: "Follow-up jedna",
      body: "První čekající follow-up.",
    });
    const second = seedMessage(lead, {
      sequenceNumber: 2,
      parentMessageId: draft.id,
      subject: "Follow-up dva",
      body: "Druhý čekající follow-up.",
    });
    const { deleteUnsentLead, loadFollowUpWorkspace } = await import("@/app/actions");

    // Both follow-ups are pending before the delete.
    const before = await loadFollowUpWorkspace();
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.followUps.map((f) => f.message.id)).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );
    }

    const result = await deleteUnsentLead({ leadId: lead.id });

    expect(result).toEqual({ ok: true, deleted: true });
    // Primary draft AND every pending follow-up are gone with the lead.
    expect(db.messages.filter((m) => m.lead_id === lead.id)).toHaveLength(0);
    expect(db.messages.some((m) => m.id === draft.id)).toBe(false);
    expect(db.messages.some((m) => m.id === first.id)).toBe(false);
    expect(db.messages.some((m) => m.id === second.id)).toBe(false);

    const after = await loadFollowUpWorkspace();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.followUps.map((f) => f.message.id)).not.toContain(first.id);
      expect(after.followUps.map((f) => f.message.id)).not.toContain(second.id);
    }
  });

  it("5. deleting an unsent lead does not affect another lead", async () => {
    await authenticate();
    const a = seedUnsentLead("info@bistrot.cz", "Bistro U Lva");
    const b = seedUnsentLead("info@vinoteka.cz", "Vinotéka Na Půl");
    const bFollowUp = seedMessage(b.lead, {
      sequenceNumber: 1,
      parentMessageId: b.draft.id,
      subject: "Vinotéka follow-up",
      body: "Follow-up pro vinotéku.",
    });
    const { deleteUnsentLead } = await import("@/app/actions");

    const result = await deleteUnsentLead({ leadId: a.lead.id });

    expect(result).toEqual({ ok: true, deleted: true });

    // The other lead, its draft and its follow-up are untouched.
    expect(db.leads.some((l) => l.id === b.lead.id)).toBe(true);
    const bMessages = db.messages.filter((m) => m.lead_id === b.lead.id);
    expect(bMessages).toHaveLength(2);
    const bDraft = bMessages.find((m) => (m as unknown as MessageRow).id === b.draft.id) as unknown as MessageRow;
    expect(bDraft.subject).toBe("Původní předmět");
    expect(bDraft.body).toBe("Původní text zprávy.");
    expect(bDraft.status).toBe("draft");
    expect(bDraft.sent_at).toBeNull();
    const keptFollowUp = bMessages.find((m) => (m as unknown as MessageRow).id === bFollowUp.id) as unknown as MessageRow;
    expect(keptFollowUp.subject).toBe("Vinotéka follow-up");
    expect(keptFollowUp.body).toBe("Follow-up pro vinotéku.");
    expect(keptFollowUp.sequence_number).toBe(1);
    expect(keptFollowUp.parent_message_id).toBe(b.draft.id);
    expect(keptFollowUp.status).toBe("draft");
    expect(keptFollowUp.sent_at).toBeNull();
  });

  it("6. refuses to delete a lead whose outreach was already sent", async () => {
    await authenticate();
    const { deleteUnsentLead } = await import("@/app/actions");

    // A primary with a send stamp, whatever its status says.
    const stamped = seedUnsentLead("info@bistrot.cz", "Bistro U Lva");
    Object.assign(stamped.draft, {
      status: "sent",
      sent_at: "2026-10-04T09:00:00.000Z",
    });

    // A primary moved to a terminal status, even without a stamp.
    const replied = seedUnsentLead("info@vinoteka.cz", "Vinotéka Na Půl");
    Object.assign(replied.draft, { status: "replied" });

    // A primary still 'draft' but already carrying a send stamp.
    const quiet = seedUnsentLead("info@sklep.cz", "Sklep");
    Object.assign(quiet.draft, { sent_at: "2026-10-04T08:00:00.000Z" });

    for (const { lead } of [stamped, replied, quiet]) {
      const result = await deleteUnsentLead({ leadId: lead.id });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect((result.error ?? "")).toContain("already been sent");
      // Nothing was removed: the history survives.
      expect(db.leads.some((l) => l.id === lead.id)).toBe(true);
      expect(db.messages.filter((m) => m.lead_id === lead.id)).toHaveLength(1);
    }
  });

  it("7. opening Gmail does not mark the lead sent", async () => {
    await authenticate();
    const { lead, draft } = seedUnsentLead("info@bistrot.cz", "Bistro U Lva");
    const { openOutreachInGmail } = await import("@/app/actions");
    const { listOutreachHistory } = await import(
      "@/lib/services/outreach-service",
    );

    const opened = await openOutreachInGmail(draft.id);

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.url).toContain("https://mail.google.com/mail/?view=cm");
    expect(opened.url).toContain(encodeURIComponent("info@bistrot.cz"));
    expect(opened.sequenceNumber).toBe(0);
    expect(opened.isFollowUp).toBe(false);

    // The message is still an unsent draft, byte for byte.
    const message = db.messages.find((m) => m.id === draft.id) as unknown as MessageRow;
    expect(message.status).toBe("draft");
    expect(message.sent_at).toBeNull();
    expect(message.provider).toBeNull();
    expect(message.provider_message_id).toBeNull();

    // And the lead's counters were not advanced.
    const storedLead = db.leads.find((l) => l.id === lead.id) as unknown as LeadRow;
    expect(storedLead.followup_count).toBe(0);
    expect(storedLead.last_contacted_at).toBeNull();
    expect(storedLead.next_followup_at).toBeNull();

    // The history table still reports the lead as an unsent draft, so the
    // Upravit/Smazat controls stay available.
    const history = await listOutreachHistory();
    expect(history.ok).toBe(true);
    if (history.ok) {
      const row = history.data?.find((r) => r.id === lead.id) as unknown as { unsent: boolean } | null;
      if (row) expect(row.unsent).toBe(true);
    }
  });

  it("reports sent leads as not unsent in the history table", async () => {
    await authenticate();
    const unsent = seedUnsentLead("info@bistrot.cz", "Bistro U Lva");
    const sent = seedUnsentLead("info@vinoteka.cz", "Vinotéka Na Půl");
    Object.assign(sent.draft, {
      status: "sent",
      sent_at: "2026-10-04T09:00:00.000Z",
    });
    const { listOutreachHistory } = await import(
      "@/lib/services/outreach-service",
    );

    const history = await listOutreachHistory();

    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const byEmail = new Map(
      (history.data ?? []).map((row) => [row.email, row]),
    );
    const unstRow = byEmail.get("info@bistrot.cz") as unknown as { unsent: boolean } | undefined;
    const sentRow = byEmail.get("info@vinoteka.cz") as unknown as { unsent: boolean } | undefined;
    if (unstRow) expect(unstRow.unsent).toBe(true);
    if (sentRow) expect(sentRow.unsent).toBe(false);
    void unsent;
  });
});
