import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { findLeadByEmail } from "@/lib/services/lead-service";
import { DuplicateNotice } from "@/components/duplicate-notice";
import { ALREADY_CONTACTED, ALREADY_CONTACTED_DOMAIN } from "@/lib/types";

/**
 * What the lead pipeline is told about an address.
 *
 * `findLeadByEmail()` is the single answer behind the composer's badge, so this
 * is where "may this address be contacted at all?" is decided for the UI. The
 * decision is reported, never enforced here: the send transition re-checks
 * independently, and a UI that said "yes" would not make a send legal.
 */

type Row = Record<string, unknown>;

const db = { leads: [] as Row[], messages: [] as Row[], historical: [] as Row[] };

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, raw]) => {
    if (Array.isArray(raw)) return raw.includes(row[column]);
    // `neq` is recorded as a `!`-prefixed sentinel, the same trick the other
    // fakes in this repo use for `not`.
    if (typeof raw === "string" && raw.startsWith("!")) return row[column] !== raw.slice(1);
    return row[column] === raw;
  });
}

function store(table: string): Row[] {
  if (table === "leads") return db.leads;
  if (table === "outreach_messages") return db.messages;
  if (table === "historical_outreach") return db.historical;
  throw new Error(`unexpected table ${table}`);
}

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let order: { column: string; ascending: boolean } | null = null;
      let columns = "";
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

      b.eq = (column: string, value: unknown) => {
        filters.push([column, value]);
        return b;
      };
      b.neq = (column: string, value: unknown) => {
        filters.push([column, `!${String(value)}`]);
        return b;
      };
      b.order = (column: string, options: { ascending?: boolean }) => {
        order = { column, ascending: options?.ascending ?? true };
        return b;
      };
      b.limit = () => b;
      b.select = () => b;
      b.maybeSingle = async () => {
        const row = matched()[0] ?? null;
        if (!row || !columns.includes("outreach_messages(")) return { data: row, error: null };
        const { outreach_messages: _ignored, ...rest } = row;
        void _ignored;
        return {
          data: {
            ...rest,
            outreach_messages: db.messages
              .filter((m) => m.lead_id === row.id)
              .map(({ id, status, sent_at, created_at }) => ({ id, status, sent_at, created_at })),
          },
          error: null,
        };
      };
      b.then = (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(onFulfilled({ data: matched(), error: null }));

      return {
        select: (cols?: string) => {
          columns = cols ?? "";
          return b;
        },
      };
    },
  }),
}));

vi.mock("server-only", () => ({}));

function seedHistorical(rows: Row[]) {
  db.historical = rows.map((row) => {
    const domain = normalize(row.domain).replace(/^www\./, "");
    return {
      ...row,
      email_normalized: normalize(row.email),
      domain_normalized: domain,
      is_shared_provider: domain === "gmail.com" || domain === "seznam.cz",
    };
  });
}

beforeEach(() => {
  db.leads = [];
  db.messages = [];
  db.historical = [];
});

describe("lead pipeline — canContact from imported history", () => {
  it("reports a permanent refusal for an address the legacy account pitched", async () => {
    seedHistorical([
      {
        email: "info@bistro.cz",
        company: "Bistro",
        domain: "bistro.cz",
        contact_count: 3,
        first_contact_at: "2026-09-01T09:00:00.000Z",
        last_contact_at: "2026-09-18T09:00:00.000Z",
        source: "historical_import",
      },
    ]);

    const result = await findLeadByEmail("  INFO@Bistro.cz ");

    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) throw new Error("expected a result");
    expect(result.data.canContact).toBe(false);
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED);
    expect(result.data.state).toBe("contacted");
    expect(result.data.historicalContact?.matchedOn).toBe("email");
    expect(result.data.historicalContact?.contactCount).toBe(3);
    expect(result.data.lastContactedAt).toBe("2026-09-18T09:00:00.000Z");
    // No Pepa lead exists for this address, which is exactly why the lead table
    // alone would have called it "new".
    expect(result.data.lead).toBeNull();
  });

  it("reports a company-level refusal for a second mailbox at a known company", async () => {
    seedHistorical([
      {
        email: "info@bistro.cz",
        company: "Bistro",
        domain: "bistro.cz",
        contact_count: 1,
        first_contact_at: "2026-09-01T09:00:00.000Z",
        last_contact_at: "2026-09-18T09:00:00.000Z",
        source: "historical_import",
      },
    ]);

    const result = await findLeadByEmail("objednavky@bistro.cz");

    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) throw new Error("expected a result");
    expect(result.data.canContact).toBe(false);
    expect(result.data.blockReason).toBe(ALREADY_CONTACTED_DOMAIN);
    expect(result.data.historicalContact?.normalizedEmail).toBe("info@bistro.cz");
  });

  it("allows an unrelated business that merely shares a mailbox provider", async () => {
    seedHistorical([
      {
        email: "a.gym@gmail.com",
        company: "Gym",
        domain: "gmail.com",
        contact_count: 2,
        first_contact_at: "2026-09-01T09:00:00.000Z",
        last_contact_at: "2026-09-18T09:00:00.000Z",
        source: "historical_import",
      },
    ]);

    const result = await findLeadByEmail("b.restaurant@gmail.com");

    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) throw new Error("expected a result");
    expect(result.data.canContact).toBe(true);
    expect(result.data.blockReason).toBeNull();
    expect(result.data.state).toBe("new");
  });

  it("allows an address with no history at all", async () => {
    const result = await findLeadByEmail("novy@bistro.cz");

    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) throw new Error("expected a result");
    expect(result.data.canContact).toBe(true);
    expect(result.data.blockReason).toBeNull();
    expect(result.data.historicalContact).toBeNull();
  });
});

describe("UI — the already-contacted state is visible, and read-only", () => {
  const base = {
    state: "contacted" as const,
    normalizedEmail: "info@bistro.cz",
    lead: null,
    messageCount: 0,
    sentCount: 0,
    lastContactedAt: "2026-09-18T09:00:00.000Z",
    historicalContact: {
      matchedOn: "email" as const,
      normalizedEmail: "info@bistro.cz",
      normalizedDomain: "bistro.cz",
      company: "Bistro",
      contactCount: 3,
      firstContactAt: "2026-09-01T09:00:00.000Z",
      lastContactAt: "2026-09-18T09:00:00.000Z",
      source: "historical_import",
    },
    canContact: false,
    blockReason: ALREADY_CONTACTED,
  };

  it("renders the date and the number of contacts", () => {
    const markup = renderToStaticMarkup(
      <DuplicateNotice result={base} pending={false} error={null} />,
    );

    expect(markup).toContain("Already contacted");
    expect(markup).toContain("18 Sept 2026");
    expect(markup).toContain("Contacts: 3");
    expect(markup).toContain("blocked");
  });

  it("offers no control to dismiss or override the state", () => {
    const markup = renderToStaticMarkup(
      <DuplicateNotice result={base} pending={false} error={null} />,
    );

    // A lead is never marked contacted by hand, and nothing here can be turned
    // into permission: the backend refuses the send regardless of what the
    // operator does with this badge.
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<form");
  });

  it("keeps the historical line visible even when a lead row also exists", () => {
    const markup = renderToStaticMarkup(
      <DuplicateNotice
        result={{
          ...base,
          lead: {
            id: "lead-1",
            email: "info@bistro.cz",
            company_name: "Bistro",
            contact_name: null,
            status: "ready",
            created_at: "2026-10-01T00:00:00.000Z",
            updated_at: "2026-10-01T00:00:00.000Z",
            last_contacted_at: null,
            next_followup_at: null,
            followup_count: 0,
          },
          messageCount: 1,
        }}
        pending={false}
        error={null}
      />,
    );

    expect(markup).toContain("Contacts: 3");
  });
});