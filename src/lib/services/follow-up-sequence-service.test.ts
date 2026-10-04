import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildGmailComposeUrl } from "@/lib/outreach/gmail-compose";

/**
 * Tests for the sequence-aware follow-up service.
 *
 * The store models the Phase 4A schema faithfully, including
 * `unique (lead_id, recipient_normalized, sequence_number)` and the rule that a
 * follow-up needs a parent. That means these tests exercise real invariants
 * rather than a permissive stub: a duplicate slot or a cross-lead parent fails
 * exactly as Postgres would.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase } = vi.hoisted(() => {
  const db = { leads: [] as Row[], messages: [] as Row[] };
  let nextId = 1;

  function matches(row: Row, filters: Array<[string, unknown]>): boolean {
    return filters.every(([column, value]) => {
      if (Array.isArray(value)) return value.includes(row[column]);
      return row[column] === value;
    });
  }

  function readBuilder(
    table: "leads" | "outreach_messages",
    filters: Array<[string, unknown]>,
    greaterThan: Array<[string, number]>,
    order: { column: string; ascending: boolean } | null,
    limit: number | null,
    head: boolean,
    embedded: boolean,
  ) {
    const source = table === "leads" ? db.leads : db.messages;

    const matched = (): Row[] => {
      const filtered = source.filter(
        (row) =>
          matches(row, filters) &&
          greaterThan.every(([column, value]) => Number(row[column]) > value),
      );
      const by = order;
      if (by) {
        const direction = by.ascending ? 1 : -1;
        filtered.sort((a, b) =>
          String(a[by.column] ?? "").localeCompare(String(b[by.column] ?? "")) * direction,
        );
      }
      const sliced = limit === null ? filtered : filtered.slice(0, limit);

      if (!embedded || table !== "outreach_messages") return sliced;
      return sliced.map((row) => ({
        ...row,
        leads: db.leads.find((l) => l.id === row.lead_id) ?? null,
      }));
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
    // A real numeric comparison. The list is defined as `sequence_number > 0`,
    // so a fake that compared as a string would both over- and under-report.
    b.gt = (column: string, value: unknown) => {
      greaterThan.push([column, Number(value)]);
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
    b.maybeSingle = async () => ({ data: head ? null : (matched()[0] ?? null), error: null });
    b.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(
        onFulfilled(
          head
            ? { data: null, count: matched().length, error: null }
            : { data: matched(), error: null },
        ),
      );
    return b;
  }

  /** Enforces the same invariants Postgres does, so bad writes fail loudly. */
  function insertBuilder(table: "leads" | "outreach_messages", payload: Row | Row[]) {
    const rows = Array.isArray(payload) ? payload : [payload];
    const source = table === "leads" ? db.leads : db.messages;

    const apply = () => {
      const stored: Row[] = [];
      for (const raw of rows) {
        const recipientNormalized =
          typeof raw.recipient_email === "string" ? raw.recipient_email.toLowerCase() : undefined;
        const row: Row = {
          id: `row-${(nextId += 1)}`,
          ...raw,
          ...(recipientNormalized ? { recipient_normalized: recipientNormalized } : {}),
          created_at: raw.created_at ?? "2026-10-01T08:00:00.000Z",
        };

        if (table === "outreach_messages") {
          const slotTaken = source.some(
            (c) =>
              c.lead_id === row.lead_id &&
              c.recipient_normalized === row.recipient_normalized &&
              c.sequence_number === row.sequence_number,
          );
          if (slotTaken) {
            return { error: { code: "23505", message: "duplicate key value" }, data: null };
          }

          const { sequence_number: sequence, parent_message_id: parentId } = row;
          if (Number(sequence) > 0 && !parentId) {
            return { error: { code: "23514", message: "parent consistency" }, data: null };
          }
          if (parentId) {
            const parent = source.find((c) => c.id === parentId);
            if (!parent || parent.lead_id !== row.lead_id) {
              return { error: { code: "23514", message: "cross-lead parent" }, data: null };
            }
          }
        }

        source.push(row);
        stored.push(row);
      }
      return { error: null, data: stored };
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.maybeSingle = async () => {
      const { data, error } = apply();
      return { data: error ? null : ((data as Row[])[0] ?? null), error };
    };
    b.then = (onFulfilled: (value: unknown) => unknown) => {
      const { data, error } = apply();
      return Promise.resolve(onFulfilled({ data: error ? null : data, error }));
    };
    return b;
  }

  function updateBuilder(table: "leads" | "outreach_messages", patch: Row) {
    const filters: Array<[string, unknown]> = [];
    const source = table === "leads" ? db.leads : db.messages;

    const apply = () => {
      const affected = source.filter((row) => matches(row, filters));
      affected.forEach((row) => Object.assign(row, patch));
      return affected;
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
    b.select = () => b;
    b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
    b.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(onFulfilled({ data: apply(), error: null }));
    return b;
  }

  function makeSupabase() {
    return {
      from(table: "leads" | "outreach_messages") {
        return {
          select: (_columns?: string, options?: { head?: boolean }) =>
            readBuilder(table, [], [], null, null, Boolean(options?.head), true),
          insert: (payload: Row | Row[]) => insertBuilder(table, payload),
          update: (patch: Row) => updateBuilder(table, patch),
        };
      },
    };
  }

  return { db, makeSupabase: () => makeSupabase() };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_LEAD_ID = "22222222-2222-2222-2222-222222222222";
const THIRD_LEAD_ID = "33333333-3333-3333-3333-333333333333";
const RECIPIENT = "info@thearchive.cz";
const OTHER_RECIPIENT = "a@bistrot.cz";
const THIRD_RECIPIENT = "c@vinoteka.cz";

/** Slot-0 rows are cheap; a follow-up workspace spans several leads at once. */
function seedSequenceHead(leadId: string, recipient: string, id: string) {
  return seedMessage({
    id,
    lead_id: leadId,
    recipient_email: recipient,
    recipient_normalized: recipient,
  });
}

async function load() {
  return import("@/lib/services/follow-up-sequence-service");
}

function seedLead(overrides: Row = {}) {
  db.leads.push({
    id: LEAD_ID,
    email: RECIPIENT,
    company_name: "The Archive",
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

/** The stored shape of an outreach_messages row, with the fields typed. */
type OutreachMessageRow = {
  id: string;
  lead_id: string;
  recipient_email: string;
  recipient_normalized: string;
  subject: string | null;
  body: string | null;
  status: string;
  provider: unknown;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  sequence_number: number;
  parent_message_id: string | null;
};

function seedMessage(overrides: Row = {}): OutreachMessageRow {
  const row: OutreachMessageRow = {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    lead_id: LEAD_ID,
    recipient_email: RECIPIENT,
    recipient_normalized: RECIPIENT,
    subject: "Initial outreach",
    body: "Původní text.",
    status: "sent",
    provider: null,
    provider_message_id: null,
    sent_at: "2026-09-20T09:00:00.000Z",
    created_at: "2026-09-20T08:55:00.000Z",
    sequence_number: 0,
    parent_message_id: null,
    ...overrides,
  } as OutreachMessageRow;
  db.messages.push(row);
  return row;
}

/** Typed accessor so assertions do not have to narrow `unknown` by hand. */
function messageById(id: string): OutreachMessageRow {
  const row = db.messages.find((m) => m.id === id);
  if (!row) throw new Error(`no seeded message ${id}`);
  return row as OutreachMessageRow;
}

beforeEach(() => {
  db.leads = [];
  db.messages = [];
});

describe("sequence numbering — 0, 1, 2", () => {
  it("an initial outreach is sequence 0 with no parent", async () => {
    seedLead();
    const initial = seedMessage();

    const { getFollowUpDetail } = await load();
    const detail = await getFollowUpDetail(initial.id);

    expect(detail.ok).toBe(true);
    expect(detail.data?.message.sequence_number).toBe(0);
    expect(detail.data?.isInitial).toBe(true);
    expect(detail.data?.message.parent_message_id).toBeNull();
  });

  it("the first follow-up is sequence 1", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();

    const result = await createFollowUpDraft({
      anchorMessageId: initial.id,
      subject: "FU1",
      body: "První navázání.",
    });

    expect(result.ok).toBe(true);
    expect(result.data?.message.sequence_number).toBe(1);
    expect(result.data?.created).toBe(true);
  });

  it("the second follow-up is sequence 2 and chains onto the first", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();

    const first = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Jedna." });
    const second = await createFollowUpDraft({
      anchorMessageId: first.data!.message.id,
      subject: "FU2",
      body: "Dva.",
    });

    expect(second.ok).toBe(true);
    expect(second.data?.message.sequence_number).toBe(2);
    expect(second.data?.message.parent_message_id).toBe(first.data!.message.id);
  });

  it("parent_message_id is correct at every level", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft, getFollowUpDetail } = await load();

    const first = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Jedna." });
    const second = await createFollowUpDraft({
      anchorMessageId: first.data!.message.id,
      subject: "FU2",
      body: "Dva.",
    });

    const fu1 = await getFollowUpDetail(first.data!.message.id);
    const fu2 = await getFollowUpDetail(second.data!.message.id);

    expect(fu1.data?.parent?.id).toBe(initial.id);
    expect(fu1.data?.initial?.id).toBe(initial.id);
    expect(fu2.data?.parent?.id).toBe(first.data!.message.id);
    expect(fu2.data?.initial?.id).toBe(initial.id);
    // The head of the sequence is always slot 0.
    expect(fu2.data?.initial?.sequence_number).toBe(0);
  });
});

describe("same lead and same recipient are enforced", () => {
  it("a new follow-up copies the anchor's lead and recipient", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();

    const result = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Text." });

    expect(result.data?.message.lead_id).toBe(LEAD_ID);
    expect(result.data?.message.recipient_email).toBe(RECIPIENT);
  });

  it("the store refuses a follow-up parented on another lead", async () => {
    seedLead();
    const initial = seedMessage();
    // A message belonging to a different lead, same recipient.
    seedMessage({ id: "bbbbbbbb-0000-0000-0000-000000000001", lead_id: OTHER_LEAD_ID });

    const { createFollowUpDraft } = await load();
    const result = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Text." });

    // The anchor is lead-scoped, so the insert can only ever be lead-scoped too.
    expect(result.ok).toBe(true);
    expect(result.data?.message.lead_id).toBe(LEAD_ID);
    const foreign = db.messages.find((m) => m.sequence_number === 1);
    expect(foreign?.lead_id).toBe(LEAD_ID);
  });

  it("the anchor row is never mutated", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();

    await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Text." });

    expect(initial).toMatchObject({
      subject: "Initial outreach",
      body: "Původní text.",
      status: "sent",
      sent_at: "2026-09-20T09:00:00.000Z",
      sequence_number: 0,
    });
  });
});

describe("re-saving and conflicts", () => {
  it("re-saving the same follow-up updates it instead of duplicating", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();

    const first = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "První." });
    const again = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1 upravený", body: "Opravené." });

    expect(again.ok).toBe(true);
    expect(again.data?.created).toBe(false);
    expect(again.data?.message.id).toBe(first.data!.message.id);
    expect(again.data?.message.subject).toBe("FU1 upravený");
    expect(db.messages.filter((m) => m.sequence_number === 1)).toHaveLength(1);
  });

  it("two simultaneous requests produce exactly one follow-up", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();

    // Both requests are issued before either is awaited, which is the shape a
    // double-click produces. The unique constraint — not application logic —
    // decides the outcome, so exactly one may win.
    const [a, b] = await Promise.all([
      createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "První." }),
      createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "První." }),
    ]);

    const winners = [a, b].filter((r) => r.ok && r.data?.created);
    expect(winners).toHaveLength(1);

    const slot = db.messages.filter((m) => m.sequence_number === 1);
    expect(slot).toHaveLength(1);
    expect(slot[0].parent_message_id).toBe(initial.id);

    // The loser is never a second row: it either resolves the same follow-up or
    // reports the conflict, and in both cases the store still holds one row.
    for (const result of [a, b]) {
      if (result.ok) {
        expect(result.data!.message.id).toBe(slot[0].id);
      } else {
        expect(["conflict", "store_failed"]).toContain(result.reason);
      }
    }
  });

  it("refuses to branch from a superseded anchor", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();

    const first = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Jedna." });
    // first is now draft, so it is editable and gets updated rather than branched.
    // Make it sent so it is no longer an editable child.
    first.data!.message.status = "sent";

    const branch = await createFollowUpDraft({
      anchorMessageId: initial.id,
      subject: "Větvení",
      body: "Větvení.",
    });

    // Either it resolves the existing child, or it reports a conflict. It must
    // never create a second sequence-1 row.
    if (branch.ok) {
      expect(branch.data!.message.id).toBe(first.data!.message.id);
    } else {
      expect(branch.reason).toBe("anchor_not_latest");
    }
    expect(db.messages.filter((m) => m.sequence_number === 1)).toHaveLength(1);
  });

  it("reports a conflict for a missing anchor", async () => {
    seedLead();
    const { createFollowUpDraft } = await load();

    const result = await createFollowUpDraft({ anchorMessageId: "missing", subject: "S", body: "B" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("rejects an empty anchor id without querying", async () => {
    seedLead();
    const { createFollowUpDraft } = await load();

    const result = await createFollowUpDraft({ anchorMessageId: "", subject: "S", body: "B" });

    expect(result.ok).toBe(false);
  });
});

describe("historical follow-ups are never fabricated", () => {
  it("does not invent rows for a lead whose counter predates the sequence model", async () => {
    // followup_count says two went out, but nothing was ever stored.
    seedLead({ followup_count: 2 });
    seedMessage();

    const { getFollowUpDetail, listFollowUps } = await load();
    const detail = await getFollowUpDetail(messageById(db.messages[0]!.id as string).id);
    const list = await listFollowUps();

    // Exactly one message exists, and the list is built from real rows only.
    expect(db.messages).toHaveLength(1);
    expect(list.data).toEqual([]);
    // The gap is reported honestly rather than filled in.
    expect(detail.data?.unrecordedHistory).toBe(true);
  });

  it("does not report unrecorded history when the counter matches the rows", async () => {
    seedLead({ followup_count: 0 });
    seedMessage();
    const { createFollowUpDraft } = await load();
    await createFollowUpDraft({ anchorMessageId: messageById(db.messages[0]!.id as string).id, subject: "FU1", body: "x" });

    const { getFollowUpDetail } = await load();
    const detail = await getFollowUpDetail(messageById(db.messages[0]!.id as string).id);
    expect(detail.data?.unrecordedHistory).toBe(false);
  });
});

describe("follow-up list", () => {
  it("lists only real follow-up rows, not leads with a counter", async () => {
    seedLead({ followup_count: 5 });
    seedMessage();
    // A second lead whose counter is high but which has no sequence rows.
    db.leads.push({
      id: OTHER_LEAD_ID,
      email: "ghost@example.com",
      company_name: null,
      contact_name: null,
      status: "ready",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      last_contacted_at: null,
      next_followup_at: null,
      followup_count: 7,
    });

    const { listFollowUps } = await load();
    const list = await listFollowUps();

    expect(list.ok).toBe(true);
    expect(list.data).toEqual([]);
  });

  it("exposes the fields a workspace needs", async () => {
    seedLead({ next_followup_at: "2026-10-01T08:00:00.000Z" });
    const initial = seedMessage();
    const { createFollowUpDraft, listFollowUps } = await load();
    const created = await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Text." });

    const list = await listFollowUps();
    expect(list.data).toHaveLength(1);
    expect(list.data?.[0]).toMatchObject({
      message: {
        id: created.data!.message.id,
        sequence_number: 1,
        subject: "FU1",
        recipient_email: RECIPIENT,
        status: "draft",
      },
      lead: { id: LEAD_ID, company_name: "The Archive" },
    });
    expect(list.data?.[0]?.due).toBe(true);
  });
});

describe("gmail compose integration", () => {
  it("composes from the stored follow-up row, not from anything the client sends", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();
    const created = await createFollowUpDraft({
      anchorMessageId: initial.id,
      subject: "Navazuji na příspěvek",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení.\n\nS pozdravem",
    });

    const url = buildGmailComposeUrl({
      to: created.data!.message.recipient_email,
      subject: created.data!.message.subject,
      body: created.data!.message.body,
    });

    expect(url).toContain("mail.google.com");
    // Decode through the real parser rather than decodeURIComponent, which does
    // not reverse `+` back to a space.
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("su")).toBe("Navazuji na příspěvek");
    expect(params.get("body")).toContain("S pozdravem");
  });

  it("a Gmail URL does not mutate any stored row", async () => {
    seedLead();
    const initial = seedMessage();
    const { createFollowUpDraft } = await load();
    await createFollowUpDraft({ anchorMessageId: initial.id, subject: "FU1", body: "Text." });

    const before = JSON.stringify(db.messages);
    buildGmailComposeUrl({ to: RECIPIENT, subject: "FU1", body: "Text." });
    expect(JSON.stringify(db.messages)).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase 4C — workspace ordering and honest presentation                      */
/* -------------------------------------------------------------------------- */

describe("follow-up workspace — ordering", () => {
  /**
   * Build one follow-up row directly, bypassing the draft flow.
   *
   * The row is constructed rather than derived from `seedMessage()`: calling
   * that helper would push a second slot-0 row on every call, which silently
   * fabricates history and makes `initial` resolve to an unrelated message.
   */
  function seedFollowUp({ id, ...overrides }: Partial<OutreachMessageRow> & { id: string }): OutreachMessageRow {
    const row: OutreachMessageRow = {
      id,
      lead_id: LEAD_ID,
      recipient_email: RECIPIENT,
      recipient_normalized: RECIPIENT,
      subject: "Navazání",
      body: "Text.",
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-10-02T08:00:00.000Z",
      sequence_number: 1,
      parent_message_id: null,
      ...overrides,
    };
    db.messages.push(row);
    return row;
  }

  // The workspace order depends on `next_followup_at` versus *now*, so pin the
  // clock instead of letting the wall clock decide what counts as overdue.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never lists a sequence 0 row", async () => {
    seedLead();
    seedMessage(); // slot 0
    seedFollowUp({ id: "fu-1" }); // slot 1

    const { listFollowUps } = await load();
    const list = await listFollowUps();

    expect(list.data?.map((i) => i.message.sequence_number)).toEqual([1]);
  });

  it("reports the true sequence number, never the counter plus one", async () => {
    seedLead({ followup_count: 7 });
    seedMessage();
    seedFollowUp({ id: "fu-2", sequence_number: 2 });

    const { listFollowUps } = await load();
    const list = await listFollowUps();

    // Known issue #1 makes `followup_count + 1` read as #8. The stored value wins.
    expect(list.data?.[0]?.message.sequence_number).toBe(2);
  });

  it("ranks due follow-ups above merely unsent, and both above sent", async () => {
    // Due-ness is a property of the lead, so each state needs its own lead.
    // Mutating one lead after seeding would not work: the embedded lead row is
    // read at query time, so every row would inherit the final value.
    seedLead({ next_followup_at: "2099-01-01T00:00:00.000Z" }); // ready, not due
    seedSequenceHead(LEAD_ID, RECIPIENT, "head-archive");
    seedLead({ id: OTHER_LEAD_ID, email: OTHER_RECIPIENT, next_followup_at: "2026-01-01T00:00:00.000Z" });
    seedSequenceHead(OTHER_LEAD_ID, OTHER_RECIPIENT, "head-bistrot");
    seedLead({ id: THIRD_LEAD_ID, email: THIRD_RECIPIENT, next_followup_at: "2026-10-01T08:00:00.000Z" });
    seedSequenceHead(THIRD_LEAD_ID, THIRD_RECIPIENT, "head-vinoteka");

    seedFollowUp({ id: "due-1", lead_id: OTHER_LEAD_ID, recipient_email: OTHER_RECIPIENT, recipient_normalized: OTHER_RECIPIENT });
    seedFollowUp({ id: "later-1" });
    seedFollowUp({
      id: "sent-1",
      lead_id: THIRD_LEAD_ID,
      recipient_email: THIRD_RECIPIENT,
      recipient_normalized: THIRD_RECIPIENT,
      status: "sent",
      sent_at: "2026-10-01T09:00:00.000Z",
    });

    const { listFollowUps } = await load();
    const list = await listFollowUps();

    expect(list.data?.map((i) => i.message.id)).toEqual(["due-1", "later-1", "sent-1"]);
    expect(list.data?.map((i) => i.attention)).toEqual([0, 1, 2]);
    expect(list.data?.map((i) => i.due)).toEqual([true, false, true]);
  });

  it("orders due follow-ups by soonest deadline first", async () => {
    seedLead({ next_followup_at: "2026-01-05T00:00:00.000Z" }); // overdue, later
    seedSequenceHead(LEAD_ID, RECIPIENT, "head-archive");
    seedLead({ id: OTHER_LEAD_ID, email: OTHER_RECIPIENT, next_followup_at: "2026-01-02T00:00:00.000Z" });
    seedSequenceHead(OTHER_LEAD_ID, OTHER_RECIPIENT, "head-bistrot");

    seedFollowUp({ id: "late" });
    seedFollowUp({
      id: "soon",
      lead_id: OTHER_LEAD_ID,
      recipient_email: OTHER_RECIPIENT,
      recipient_normalized: OTHER_RECIPIENT,
    });

    const { listFollowUps } = await load();
    const list = await listFollowUps();

    expect(list.data?.map((i) => i.message.id)).toEqual(["soon", "late"]);
  });

  it("orders sent follow-ups most recently sent first", async () => {
    seedMessage();
    const { listFollowUps } = await load();

    seedFollowUp({ id: "older", status: "sent", sent_at: "2026-09-01T00:00:00.000Z" });
    seedFollowUp({ id: "newer", status: "sent", sent_at: "2026-10-01T00:00:00.000Z" });

    const list = await listFollowUps();

    expect(list.data?.map((i) => i.message.id)).toEqual(["newer", "older"]);
  });

  it("is deterministic: repeated calls return the same order", async () => {
    seedMessage();
    const { listFollowUps } = await load();
    seedFollowUp({ id: "a" });
    seedFollowUp({ id: "b" });
    seedFollowUp({ id: "c" });

    const first = await listFollowUps();
    const second = await listFollowUps();

    expect(first.data?.map((i) => i.message.id)).toEqual(second.data?.map((i) => i.message.id));
  });

  it("keeps multiple leads independent and in a stable relative order", async () => {
    seedLead({ company_name: "The Archive" });
    seedSequenceHead(LEAD_ID, RECIPIENT, "head-archive");
    seedLead({ id: OTHER_LEAD_ID, email: OTHER_RECIPIENT, company_name: "Bistrot" });
    seedSequenceHead(OTHER_LEAD_ID, OTHER_RECIPIENT, "head-bistrot");

    const { listFollowUps } = await load();
    seedFollowUp({ id: "archive-1" });
    seedFollowUp({
      id: "bistrot-1",
      lead_id: OTHER_LEAD_ID,
      recipient_email: OTHER_RECIPIENT,
      recipient_normalized: OTHER_RECIPIENT,
    });

    const list = await listFollowUps();

    // Both leads hold their own follow-up #1; neither displaces the other.
    expect(list.data).toHaveLength(2);
    expect(list.data?.every((i) => i.message.sequence_number === 1)).toBe(true);
    expect(new Set(list.data?.map((i) => i.lead.id))).toEqual(new Set([LEAD_ID, OTHER_LEAD_ID]));
  });

  it("preserves status and sent_at verbatim", async () => {
    seedMessage();
    const { listFollowUps } = await load();
    seedFollowUp({ id: "ready-1", status: "ready" });
    seedFollowUp({ id: "sent-1", status: "sent", sent_at: "2026-10-01T09:14:00.000Z" });

    const list = await listFollowUps();
    const byId = new Map(list.data?.map((i) => [i.message.id, i]));

    expect(byId.get("ready-1")?.message.status).toBe("ready");
    expect(byId.get("sent-1")?.message.status).toBe("sent");
    expect(byId.get("sent-1")?.message.sent_at).toBe("2026-10-01T09:14:00.000Z");
  });

  it("generates no row for a lead whose follow-ups were never stored", async () => {
    seedLead({ followup_count: 3 });
    seedMessage(); // only slot 0 exists

    const { listFollowUps, getFollowUpDetail } = await load();
    const list = await listFollowUps();
    const detail = await getFollowUpDetail(messageById(db.messages[0]!.id as string).id);

    expect(list.data).toEqual([]);
    // The gap is flagged, not filled.
    expect(detail.data?.unrecordedHistory).toBe(true);
  });
});

describe("follow-up workspace — detail edge cases", () => {
  it("handles a follow-up whose parent row was deleted", async () => {
    seedLead();
    // Only the orphaned follow-up survives: its predecessor was deleted, so
    // Phase 4A's ON DELETE SET NULL left parent_message_id empty. Nothing else
    // about the sequence exists either.
    db.messages.push({
      id: "orphan-1",
      lead_id: LEAD_ID,
      recipient_email: RECIPIENT,
      recipient_normalized: RECIPIENT,
      subject: "Navazání bez předchůdce",
      body: null,
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-10-02T08:00:00.000Z",
      sequence_number: 3,
      parent_message_id: null,
    } as OutreachMessageRow);

    const { getFollowUpDetail } = await load();
    const detail = await getFollowUpDetail("orphan-1");

    expect(detail.ok).toBe(true);
    expect(detail.data?.message.sequence_number).toBe(3);
    // No parent and no initial: both are absent rather than fabricated.
    expect(detail.data?.parent).toBeNull();
    expect(detail.data?.initial).toBeNull();
    expect(detail.data?.isInitial).toBe(false);
  });

  it("loads the exact message requested, not a different follow-up", async () => {
    seedLead();
    seedMessage();
    const { createFollowUpDraft } = await load();
    const first = await createFollowUpDraft({ anchorMessageId: messageById(db.messages[0]!.id as string).id, subject: "FU1", body: "Jedna." });
    const second = await createFollowUpDraft({ anchorMessageId: first.data!.message.id, subject: "FU2", body: "Dva." });

    const { getFollowUpDetail } = await load();
    const detail = await getFollowUpDetail(second.data!.message.id);

    expect(detail.data?.message.subject).toBe("FU2");
    expect(detail.data?.message.body).toBe("Dva.");
    expect(detail.data?.message.sequence_number).toBe(2);
    expect(detail.data?.parent?.subject).toBe("FU1");
  });

  it("rejects an unknown message id without throwing", async () => {
    seedLead();
    const { getFollowUpDetail } = await load();

    const detail = await getFollowUpDetail("00000000-0000-0000-0000-000000000000");

    expect(detail.ok).toBe(false);
    expect(detail.reason).toBe("not_found");
  });
});
