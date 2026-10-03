import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the Outreach Activity service.
 *
 * The store models the Phase 4A schema faithfully, including the parts that
 * matter here: `status`, `sent_at`, `sequence_number`, `parent_message_id`, and
 * Postgres' NULL ordering (ASC sorts NULLs last, DESC sorts them FIRST unless
 * `nullsFirst: false` is requested).
 *
 * That last detail is load-bearing. Without `nullsFirst: false`, a sent row with
 * no `sent_at` would occupy the top of the window and displace real sends — a
 * fake that ignored null ordering could not catch that, so this one does not.
 */

type Row = Record<string, unknown>;

const { db, makeSupabase, stats } = vi.hoisted(() => {
  const db = { leads: [] as Row[], messages: [] as Row[] };
  // Query and mutation counters: these are how the N+1 and read-only
  // properties are asserted, so they are recorded by the fake itself rather
  // than inferred from the code under test.
  const stats = { queries: 0, writes: [] as string[] };

  interface Order {
    column: string;
    ascending: boolean;
    nullsFirst: boolean;
  }

  function matches(row: Row, filters: Array<[string, unknown]>): boolean {
    return filters.every(([column, value]) => {
      if (Array.isArray(value)) return value.includes(row[column]);
      return row[column] === value;
    });
  }

  function compare(a: Row, b: Row, order: Order): number {
    const left = a[order.column] ?? null;
    const right = b[order.column] ?? null;

    // Postgres sorts NULLs last for ASC and first for DESC by default.
    if (left === null && right !== null) return order.nullsFirst ? -1 : 1;
    if (left !== null && right === null) return order.nullsFirst ? 1 : -1;
    if (left === null && right === null) return 0;

    const cmp = String(left).localeCompare(String(right));
    return order.ascending ? cmp : -cmp;
  }

  /**
   * ORDER BY is one lexicographic sort over the whole list, not a chain of
   * independent sorts: the second key only decides rows the first key ties.
   * Chaining two full sorts here would let `id` re-order rows that `sent_at`
   * had already separated, which Postgres never does.
   */
  function compareAll(a: Row, b: Row, orders: Order[]): number {
    for (const order of orders) {
      const cmp = compare(a, b, order);
      if (cmp !== 0) return cmp;
    }
    return 0;
  }

  function readBuilder(
    table: "leads" | "outreach_messages",
    embed: boolean,
    filters: Array<[string, unknown]>,
    orders: Order[],
    limit: number | null,
  ) {
    const source = table === "leads" ? db.leads : db.messages;

    const matched = (): Row[] => {
      const filtered = source.filter((row) => matches(row, filters));
      filtered.sort((a, b) => compareAll(a, b, orders));
      const sliced = limit === null ? filtered : filtered.slice(0, limit);

      if (!embed || table !== "outreach_messages") return sliced;
      return sliced.map((row) => ({
        ...row,
        leads: db.leads.find((l) => l.id === row.lead_id) ?? null,
      }));
    };

    stats.queries += 1;

    const builder: Record<string, unknown> = {};
    builder.eq = (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    };
    builder.order = (
      column: string,
      options?: { ascending?: boolean; nullsFirst?: boolean },
    ) => {
      const ascending = options?.ascending ?? true;
      orders.push({
        column,
        ascending,
        nullsFirst: options?.nullsFirst ?? !ascending,
      });
      return builder;
    };
    builder.limit = (n: number) => {
      limit = n;
      return builder;
    };
    builder.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    builder.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(onFulfilled({ data: matched(), error: null }));

    return builder;
  }

  function makeSupabase() {
    return {
      from(table: "leads" | "outreach_messages") {
        return {
          select: (columns?: string) =>
            readBuilder(table, (columns ?? "").includes("leads("), [], [], null),
          // Any write verb is recorded so a mutation fails the test loudly.
          insert: () => {
            stats.writes.push("INSERT");
            throw new Error("activity must not write");
          },
          update: () => {
            stats.writes.push("UPDATE");
            throw new Error("activity must not write");
          },
          upsert: () => {
            stats.writes.push("UPSERT");
            throw new Error("activity must not write");
          },
          delete: () => {
            stats.writes.push("DELETE");
            throw new Error("activity must not write");
          },
        };
      },
    };
  }

  return { db, makeSupabase: () => makeSupabase(), stats };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

const ARCHIVE = "11111111-1111-1111-1111-111111111111";
const BISTROT = "22222222-2222-2222-2222-222222222222";
const VINOTEKA = "33333333-3333-3333-3333-333333333333";

async function load() {
  return import("@/lib/services/outreach-activity-service");
}

function seedLead(id: string, email: string, company: string | null, overrides: Row = {}) {
  db.leads.push({
    id,
    email,
    company_name: company,
    contact_name: null,
    status: "follow_up",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    last_contacted_at: null,
    next_followup_at: null,
    followup_count: 0,
    ...overrides,
  });
}

type ActivityRow = {
  id: string;
  lead_id: string;
  recipient_email: string;
  subject: string | null;
  body: string | null;
  status: string;
  sent_at: string | null;
  created_at: string;
  sequence_number: number;
  parent_message_id: string | null;
};

let counter = 0;

/** A row with sensible defaults; only the fields a test cares about need naming. */
function seedMessage(overrides: Partial<ActivityRow> = {}): ActivityRow {
  counter += 1;
  const id = overrides.id ?? `message-${String(counter).padStart(4, "0")}`;
  const row: ActivityRow = {
    id,
    lead_id: ARCHIVE,
    recipient_email: "info@thearchive.cz",
    subject: "Nabídka pro The Archive",
    body: "Dobrý den,\n\ntext.\n\nS pozdravem",
    status: "sent",
    sent_at: "2026-10-03T09:14:00.000Z",
    created_at: "2026-10-03T08:00:00.000Z",
    sequence_number: 0,
    parent_message_id: null,
    ...overrides,
  };
  db.messages.push(row);
  return row;
}

function ids(result: Awaited<ReturnType<Awaited<ReturnType<typeof load>>["listOutreachActivity"]>>) {
  return (result.data ?? []).map((item) => item.message.id);
}

beforeEach(() => {
  db.leads = [];
  db.messages = [];
  stats.queries = 0;
  stats.writes = [];
  counter = 0;
});

/* -------------------------------------------------------------------------- */
/* Part B — only status = 'sent' is activity                                   */
/* -------------------------------------------------------------------------- */

describe("activity — what counts as activity", () => {
  it("lists only sent messages", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    const sent = seedMessage({ id: "sent-row", status: "sent" });
    seedMessage({ id: "draft-row", status: "draft", sent_at: null });
    seedMessage({ id: "ready-row", status: "ready", sent_at: null });
    seedMessage({ id: "follow-up-status", status: "follow_up", sent_at: null });
    seedMessage({ id: "failed-row", status: "blocked", sent_at: null });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.ok).toBe(true);
    expect(ids(result)).toEqual([sent.id]);
  });

  it("excludes a draft even when it carries a sent_at", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    // Status is the definition; a stray timestamp does not promote a row.
    seedMessage({ id: "draft-with-date", status: "draft", sent_at: "2026-10-03T09:14:00.000Z" });

    const { listOutreachActivity } = await load();
    expect(ids(await listOutreachActivity())).toEqual([]);
  });

  it("excludes ready and unsent follow-ups", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "initial", sent_at: "2026-10-01T09:00:00.000Z" });
    seedMessage({ id: "ready-fu", status: "ready", sequence_number: 1, sent_at: null });
    seedMessage({ id: "draft-fu", status: "draft", sequence_number: 2, sent_at: null });

    const { listOutreachActivity } = await load();
    expect(ids(await listOutreachActivity())).toEqual(["initial"]);
  });

  it("includes a lead's whole sent chain, not just the initial outreach", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    const initial = seedMessage({ id: "m0", sent_at: "2026-10-01T09:00:00.000Z" });
    seedMessage({ id: "m1", sequence_number: 1, parent_message_id: initial.id, sent_at: "2026-10-05T09:00:00.000Z" });
    seedMessage({ id: "m2", sequence_number: 2, parent_message_id: "m1", sent_at: "2026-10-12T09:00:00.000Z" });

    const { listOutreachActivity } = await load();
    // Newest first.
    expect(ids(await listOutreachActivity())).toEqual(["m2", "m1", "m0"]);
  });

  it("invents nothing for a lead whose follow-ups were never stored", async () => {
    // The counter says three follow-ups went out. No rows exist for them.
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive", { followup_count: 3 });
    seedMessage({ id: "only-row" });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data).toHaveLength(1);
    expect(ids(result)).toEqual(["only-row"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Part I — outreach type comes from sequence_number                          */
/* -------------------------------------------------------------------------- */

describe("activity — outreach type", () => {
  it("labels sequence 0 as Initial outreach", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "m0", sequence_number: 0 });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.typeLabel).toBe("Initial outreach");
  });

  it("labels sequence 1 as Follow-up #1", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "m1", sequence_number: 1, parent_message_id: "m0" });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.typeLabel).toBe("Follow-up #1");
  });

  it("labels sequence 2 as Follow-up #2", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "m2", sequence_number: 2, parent_message_id: "m1" });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.typeLabel).toBe("Follow-up #2");
  });

  it("reports the stored sequence, never the counter plus one", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive", { followup_count: 7 });
    seedMessage({ id: "m2", sequence_number: 2 });

    const { listOutreachActivity, describeOutreachType } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.typeLabel).toBe("Follow-up #2");
    expect(describeOutreachType(0)).toBe("Initial outreach");
    expect(describeOutreachType(3)).toBe("Follow-up #3");
    expect(describeOutreachType(null)).toBe("Initial outreach");
  });

  it("ignores the subject when deciding the type", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    // A follow-up whose subject claims to be the first email. The stored slot wins.
    seedMessage({ id: "m2", sequence_number: 2, subject: "First email" });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.typeLabel).toBe("Follow-up #2");
    // The subject is still shown verbatim — only the label ignores it.
    expect(result.data?.[0]?.message.subject).toBe("First email");
  });
});

/* -------------------------------------------------------------------------- */
/* Part D — ordering                                                           */
/* -------------------------------------------------------------------------- */

describe("activity — chronological order", () => {
  it("orders by sent_at descending, not created_at", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    // Created last, but sent earliest: `sent_at` is the authoritative clock.
    seedMessage({ id: "created-late", sent_at: "2026-09-01T09:00:00.000Z", created_at: "2026-10-03T23:00:00.000Z" });
    seedMessage({ id: "sent-late", sent_at: "2026-10-03T21:00:00.000Z", created_at: "2026-09-01T09:00:00.000Z" });

    const { listOutreachActivity } = await load();
    expect(ids(await listOutreachActivity())).toEqual(["sent-late", "created-late"]);
  });

  it("breaks a sent_at tie on message id, descending", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "m-alpha", sent_at: "2026-10-03T09:00:00.000Z" });
    seedMessage({ id: "m-charlie", sent_at: "2026-10-03T09:00:00.000Z" });
    seedMessage({ id: "m-bravo", sent_at: "2026-10-03T09:00:00.000Z" });

    const { listOutreachActivity } = await load();
    expect(ids(await listOutreachActivity())).toEqual(["m-charlie", "m-bravo", "m-alpha"]);
  });

  it("is deterministic across repeated calls", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "a", sent_at: "2026-10-03T09:00:00.000Z" });
    seedMessage({ id: "b", sent_at: "2026-10-03T09:00:00.000Z" });
    seedMessage({ id: "c", sent_at: "2026-10-02T09:00:00.000Z" });

    const { listOutreachActivity } = await load();
    expect(ids(await listOutreachActivity())).toEqual(ids(await listOutreachActivity()));
  });

  it("sorts a sent row with no timestamp last, and keeps it out of a full window", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "newest", sent_at: "2026-10-03T09:00:00.000Z" });
    // A row claiming `sent` with no timestamp. Postgres would sort this FIRST
    // under a plain DESC, which is why the service passes `nullsFirst: false`.
    seedMessage({ id: "no-timestamp", sent_at: null });

    const { listOutreachActivity } = await load();

    // With a window of one, the real send must win the slot.
    expect(ids(await listOutreachActivity(1))).toEqual(["newest"]);
    // With room, the anomalous row is still listed — but at the bottom.
    expect(ids(await listOutreachActivity())).toEqual(["newest", "no-timestamp"]);
  });

  it("keeps multiple leads independent", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedLead(BISTROT, "info@bistrotpuglia.cz", "Bistrot Puglia");
    seedLead(VINOTEKA, "hello@vinoteka.cz", "Vinoteka");

    seedMessage({ id: "archive-1", lead_id: ARCHIVE, sent_at: "2026-10-03T09:14:00.000Z" });
    seedMessage({ id: "bistrot-1", lead_id: BISTROT, sent_at: "2026-10-03T11:32:00.000Z" });
    seedMessage({ id: "vinoteka-1", lead_id: VINOTEKA, sent_at: "2026-10-03T14:08:00.000Z" });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(ids(result)).toEqual(["vinoteka-1", "bistrot-1", "archive-1"]);
    expect(new Set(result.data?.map((i) => i.lead.id))).toEqual(new Set([ARCHIVE, BISTROT, VINOTEKA]));
    // Each row carries its own lead's name, never the first row's.
    expect(result.data?.map((i) => i.lead.company_name)).toEqual([
      "Vinoteka",
      "Bistrot Puglia",
      "The Archive",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Part C — the row carries everything the UI needs                            */
/* -------------------------------------------------------------------------- */

describe("activity — content is preserved verbatim", () => {
  it("preserves recipient, subject and body", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({
      recipient_email: "ostatni@thearchive.cz",
      subject: "Navazuji na příspěvek",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení.\n\nS pozdravem",
    });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.message.recipient_email).toBe("ostatni@thearchive.cz");
    expect(result.data?.[0]?.message.subject).toBe("Navazuji na příspěvek");
    expect(result.data?.[0]?.message.body).toBe("Dobrý den,\n\nrád bych vám nabídl řešení.\n\nS pozdravem");
  });

  it("preserves sent_at, status and sequence_number", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ sent_at: "2026-10-03T09:14:00.000Z", status: "sent", sequence_number: 1 });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.message.sent_at).toBe("2026-10-03T09:14:00.000Z");
    expect(result.data?.[0]?.message.status).toBe("sent");
    expect(result.data?.[0]?.message.sequence_number).toBe(1);
  });

  it("falls back to the recipient when a lead has no name", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", null);
    seedMessage();

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data?.[0]?.lead.email).toBe("info@thearchive.cz");
    expect(result.data?.[0]?.lead.company_name).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Part E / Part P — bounded, and no N+1                                       */
/* -------------------------------------------------------------------------- */

describe("activity — bounded and free of N+1", () => {
  it("returns at most the requested number of rows", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    for (let i = 1; i <= 6; i += 1) {
      seedMessage({ id: `m${i}`, sent_at: `2026-10-0${i}T09:00:00.000Z` });
    }

    const { listOutreachActivity } = await load();

    expect((await listOutreachActivity(3)).data).toHaveLength(3);
    expect((await listOutreachActivity(6)).data).toHaveLength(6);
  });

  it("defaults to a bounded window rather than loading everything", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    for (let i = 1; i <= 6; i += 1) {
      seedMessage({ id: `m${i}`, sent_at: `2026-10-0${i}T09:00:00.000Z` });
    }

    const { ACTIVITY_DEFAULT_LIMIT, listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(ACTIVITY_DEFAULT_LIMIT).toBe(100);
    expect(result.data).toHaveLength(6);
  });

  it("clamps an absurd limit instead of reading the whole table", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage();

    const { ACTIVITY_MAX_LIMIT, normalizeActivityLimit } = await load();

    expect(normalizeActivityLimit(10_000)).toBe(ACTIVITY_MAX_LIMIT);
    expect(normalizeActivityLimit(0)).toBe(100);
    expect(normalizeActivityLimit(null)).toBe(100);
    expect(normalizeActivityLimit(25)).toBe(25);
  });

  it("issues one query for the list, whatever the number of rows", async () => {
    for (let i = 1; i <= 3; i += 1) {
      seedLead(`lead-${i}`, `a${i}@x.cz`, `Company ${i}`);
    }
    seedMessage({ id: "a", lead_id: "lead-1" });
    seedMessage({ id: "b", lead_id: "lead-2" });
    seedMessage({ id: "c", lead_id: "lead-3" });

    const { listOutreachActivity } = await load();
    const result = await listOutreachActivity();

    expect(result.data).toHaveLength(3);
    // The lead is joined in by the database. A per-row lead lookup would make
    // this four, and it would grow with the list.
    expect(stats.queries).toBe(1);
  });

  it("keeps the detail lookup constant instead of walking the chain", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    const m0 = seedMessage({ id: "m0", sequence_number: 0, sent_at: "2026-10-01T09:00:00.000Z" });
    const m1 = seedMessage({ id: "m1", sequence_number: 1, parent_message_id: m0.id, sent_at: "2026-10-05T09:00:00.000Z" });
    const m2 = seedMessage({ id: "m2", sequence_number: 2, parent_message_id: m1.id, sent_at: "2026-10-12T09:00:00.000Z" });
    const m3 = seedMessage({ id: "m3", sequence_number: 3, parent_message_id: m2.id, sent_at: "2026-10-20T09:00:00.000Z" });

    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail(m3.id);

    expect(result.ok).toBe(true);
    // Message + lead + parent + head. Four, whatever the real chain length.
    expect(stats.queries).toBe(4);
  });

  it("performs no write of any kind", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    const row = seedMessage();

    const { getOutreachActivityDetail, listOutreachActivity } = await load();
    await listOutreachActivity();
    await getOutreachActivityDetail(row.id);

    expect(stats.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Part J — the detail view                                                    */
/* -------------------------------------------------------------------------- */

describe("activity detail", () => {
  it("resolves the exact sent message that was asked for", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "m0", subject: "Původní", sent_at: "2026-10-01T09:00:00.000Z" });
    const target = seedMessage({ id: "m1", sequence_number: 1, parent_message_id: "m0", subject: "Navazující", body: "Text.", sent_at: "2026-10-05T09:00:00.000Z" });
    seedMessage({ id: "m2", sequence_number: 2, parent_message_id: "m1", subject: "Třetí", sent_at: "2026-10-12T09:00:00.000Z" });

    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail(target.id);

    expect(result.ok).toBe(true);
    expect(result.data?.message.id).toBe("m1");
    expect(result.data?.message.subject).toBe("Navazující");
    expect(result.data?.message.body).toBe("Text.");
    expect(result.data?.message.recipient_email).toBe("info@thearchive.cz");
    expect(result.data?.typeLabel).toBe("Follow-up #1");
    expect(result.data?.lead.company_name).toBe("The Archive");
  });

  it("keeps the predecessor and the sequence head as context", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    const m0 = seedMessage({ id: "m0", sequence_number: 0, sent_at: "2026-10-01T09:00:00.000Z" });
    const m1 = seedMessage({ id: "m1", sequence_number: 1, parent_message_id: m0.id, sent_at: "2026-10-05T09:00:00.000Z" });

    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail(m1.id);

    expect(result.data?.parent?.id).toBe("m0");
    expect(result.data?.initial?.id).toBe("m0");
    expect(result.data?.initial?.sequence_number).toBe(0);
  });

  it("treats the initial outreach as its own head", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    const m0 = seedMessage({ id: "m0", sequence_number: 0 });

    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail(m0.id);

    expect(result.data?.isInitial).toBe(true);
    expect(result.data?.initial?.id).toBe("m0");
    expect(result.data?.parent).toBeNull();
  });

  it("reports a deleted predecessor instead of inventing one", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    // Only the orphan survives: ON DELETE SET NULL emptied parent_message_id.
    seedMessage({ id: "orphan", sequence_number: 3, parent_message_id: null });

    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail("orphan");

    expect(result.ok).toBe(true);
    expect(result.data?.parent).toBeNull();
    // The head was never stored either, so there is nothing to show.
    expect(result.data?.initial).toBeNull();
    expect(result.data?.isInitial).toBe(false);
  });

  it("refuses a predecessor that belongs to another lead", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedLead(BISTROT, "info@bistrotpuglia.cz", "Bistrot Puglia");
    // A cross-lead parent link. The write-side trigger forbids this, but the
    // read is the boundary the UI renders, so it is defended here too.
    seedMessage({ id: "foreign", lead_id: BISTROT, recipient_email: "info@bistrotpuglia.cz", sequence_number: 1, parent_message_id: null });
    const own = seedMessage({ id: "own", sequence_number: 1, parent_message_id: "foreign" });

    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail(own.id);

    expect(result.data?.parent).toBeNull();
  });

  it("cannot open a message that was never recorded as sent", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    seedMessage({ id: "draft", status: "draft", sent_at: null });

    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail("draft");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("rejects an unknown id without throwing", async () => {
    seedLead(ARCHIVE, "info@thearchive.cz", "The Archive");
    const { getOutreachActivityDetail } = await load();

    const result = await getOutreachActivityDetail("does-not-exist");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });

  it("rejects an empty id without querying", async () => {
    const { getOutreachActivityDetail } = await load();
    const result = await getOutreachActivityDetail("");

    expect(result.ok).toBe(false);
    expect(stats.queries).toBe(0);
  });
});