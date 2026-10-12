import { beforeEach, describe, expect, it, vi } from "vitest";

import { listOutreachDrafts } from "./outreach-service";

/**
 * Drafts visibility (workflow spec §2): the Drafts list contains only initial
 * outreach. Follow-up rows — due or not — must never appear there; they belong
 * to the Follow-ups workspace.
 *
 * The fake store applies `is`/`eq` the way Postgres does, so a service that
 * forgot the sequence filter would over-report and fail, rather than the fake
 * quietly hiding the follow-ups.
 */

type Row = Record<string, unknown>;

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const INITIAL_ID = "22222222-2222-2222-2222-222222222222";
const FOLLOW_UP_ID = "33333333-3333-3333-3333-333333333333";
const SENT_INITIAL_ID = "44444444-4444-4444-4444-444444444444";

const db = vi.hoisted(() => ({ leads: [] as Row[], messages: [] as Row[] }));
const eqCalls = vi.hoisted(() => [] as Array<[string, unknown]>);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseAdmin: () => makeSupabase() }));

function makeSupabase() {
  return {
    from(table: "leads" | "outreach_messages") {
      const store = table === "leads" ? db.leads : db.messages;
      return {
        select: () => {
          const filters: Array<{ kind: "is" | "eq"; column: string; value: unknown }> = [];
          let order: { column: string; ascending: boolean } | null = null;
          const b: Record<string, unknown> = {};

          b.is = (column: string, value: unknown) => {
            filters.push({ kind: "is", column, value });
            return b;
          };
          b.eq = (column: string, value: unknown) => {
            filters.push({ kind: "eq", column, value });
            eqCalls.push([column, value]);
            return b;
          };
          b.order = (column: string, options?: { ascending?: boolean }) => {
            order = { column, ascending: options?.ascending ?? true };
            return b;
          };
          b.then = (onFulfilled: (value: unknown) => unknown) => {
            let rows = store.filter((row) =>
              filters.every((f) => row[f.column] === f.value),
            );
            if (order) {
              const { column, ascending } = order;
              rows = [...rows].sort(
                (a, c) =>
                  String(a[column] ?? "").localeCompare(String(c[column] ?? "")) *
                  (ascending ? 1 : -1),
              );
            }
            // `leads!inner`: only rows with a lead survive the join.
            const data = rows
              .map((row) => {
                const lead = db.leads.find((l) => l.id === row.lead_id);
                return lead ? { ...row, leads: lead } : null;
              })
              .filter(Boolean);
            return Promise.resolve(onFulfilled({ data, error: null }));
          };
          return b;
        },
      };
    },
  };
}

function seed() {
  db.leads.push({
    id: LEAD_ID,
    email: "info@thearchive.cz",
    company_name: "The Archive",
    contact_name: null,
  });
  db.messages.push(
    {
      id: INITIAL_ID,
      lead_id: LEAD_ID,
      recipient_email: "info@thearchive.cz",
      subject: "Initial",
      body: null,
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-09-20T08:55:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
    },
    {
      id: FOLLOW_UP_ID,
      lead_id: LEAD_ID,
      recipient_email: "info@thearchive.cz",
      subject: "Follow-up",
      body: null,
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-09-29T08:55:00.000Z",
      sequence_number: 1,
      parent_message_id: INITIAL_ID,
    },
    {
      id: SENT_INITIAL_ID,
      lead_id: LEAD_ID,
      recipient_email: "sent@example.com",
      subject: "Already sent",
      body: null,
      status: "sent",
      provider: null,
      provider_message_id: null,
      sent_at: "2026-09-01T09:00:00.000Z",
      created_at: "2026-08-30T08:55:00.000Z",
      sequence_number: 0,
      parent_message_id: null,
    },
  );
}

beforeEach(() => {
  db.leads = [];
  db.messages = [];
  eqCalls.length = 0;
  seed();
});

describe("listOutreachDrafts — initial outreach only", () => {
  it("returns the unsent initial and hides the follow-up", async () => {
    const result = await listOutreachDrafts();

    expect(result.ok).toBe(true);
    expect(result.data?.map((row) => row.message.id)).toEqual([INITIAL_ID]);
  });

  it("filters on sequence_number = 0 in the query, not in the UI", async () => {
    await listOutreachDrafts();

    expect(eqCalls).toContainEqual(["sequence_number", 0]);
  });

  it("still excludes sent rows", async () => {
    const result = await listOutreachDrafts();

    expect(result.data?.map((row) => row.message.id)).not.toContain(SENT_INITIAL_ID);
  });
});
