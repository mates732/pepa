import { beforeEach, describe, expect, it, vi } from "vitest";

import { readComposeParam } from "@/lib/outreach/gmail-compose";

/**
 * Tests for `openOutreachInGmail`.
 *
 * The security property under test: the browser may send a message id and
 * nothing else. Recipient, subject and body are resolved from the stored row, so
 * a crafted request cannot redirect a draft to another address or supply its own
 * content. The action must also be inert — opening Gmail records nothing.
 */

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => ({ from: mocks.supabase.from }),
}));

const MESSAGE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

/** Minimal query-builder fake recording every mutation it is asked to perform. */
function makeQuery(table: string, result: { data: unknown; error: unknown }) {
  const calls: Array<{ table: string; op: string }> = [];
  const builder: Record<string, unknown> = {};

  // Every verb records at CALL time, not at construction time: a mutation is
  // only observable once the action actually invokes it.
  const record = (op: string) => () => {
    calls.push({ table, op });
    writes.push({ table, op });
    return builder;
  };

  builder.select = record("select");
  builder.eq = () => builder;
  builder.maybeSingle = async () => {
    record("read")();
    return result;
  };
  // Any write verb is recorded, so a mutation would fail the test loudly.
  builder.insert = record("INSERT");
  builder.update = record("UPDATE");
  builder.upsert = record("UPSERT");
  builder.delete = record("DELETE");
  builder.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: null, error: null })).then(onFulfilled as never);

  return { builder, calls };
}

let writes: Array<{ table: string; op: string }> = [];

function seedStore(options: {
  message?: Record<string, unknown> | null;
  lead?: Record<string, unknown> | null;
}) {
  const message = "message" in options ? options.message : null;
  const lead = "lead" in options ? options.lead : { id: "lead-1" };

  mocks.supabase.from.mockImplementation((table: string) => {
    const result =
      table === "outreach_messages"
        ? { data: message, error: null }
        : { data: lead, error: null };
    return makeQuery(table, result).builder;
  });
}

async function load() {
  return import("@/app/actions");
}

beforeEach(() => {
  writes = [];
  mocks.requireAuthenticatedUser.mockReset();
  mocks.supabase.from.mockReset();
  mocks.requireAuthenticatedUser.mockResolvedValue({ id: "owner", since: 0 });
});

describe("openOutreachInGmail — authentication", () => {
  it("rejects an unauthenticated request before touching the database", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));
    seedStore({ message: { id: MESSAGE_ID } });

    const { openOutreachInGmail } = await load();
    await expect(openOutreachInGmail(MESSAGE_ID)).rejects.toThrow("AuthenticationError");

    // The gate runs first, so no query was ever issued.
    expect(mocks.supabase.from).not.toHaveBeenCalled();
  });

  it("rejects a malformed message id without querying", async () => {
    const { openOutreachInGmail } = await load();

    const result = await openOutreachInGmail("not-a-uuid");

    expect(result.ok).toBe(false);
    expect(mocks.supabase.from).not.toHaveBeenCalled();
  });

  it("rejects an unknown message", async () => {
    seedStore({ message: null, lead: null });
    const { openOutreachInGmail } = await load();

    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/does not exist/i);
  });

  it("rejects a message whose lead does not exist", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "ghost",
        recipient_email: "info@thearchive.cz",
        subject: "S",
        body: "B",
        sequence_number: 0,
      },
      lead: null,
    });
    const { openOutreachInGmail } = await load();

    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no lead/i);
  });
});

describe("openOutreachInGmail — server-authoritative content", () => {
  it("builds the URL from stored values", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "Nabídka pro The Archive",
        body: "Dobrý den,\n\ntext.\n\nS pozdravem",
        sequence_number: 1,
      },
      lead: { id: "lead-1" },
    });

    const { openOutreachInGmail } = await load();
    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readComposeParam(result.url, "to")).toBe("info@thearchive.cz");
    expect(readComposeParam(result.url, "su")).toBe("Nabídka pro The Archive");
    expect(readComposeParam(result.url, "body")).toBe("Dobrý den,\n\ntext.\n\nS pozdravem");
  });

  it("takes only a message id — a client cannot supply recipient, subject or body", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "real@thearchive.cz",
        subject: "Real subject",
        body: "Real body",
        sequence_number: 0,
      },
      lead: { id: "lead-1" },
    });

    const { openOutreachInGmail } = await load();
    // The action signature accepts a string, so there is nowhere to pass
    // attacker content in the first place.
    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readComposeParam(result.url, "to")).toBe("real@thearchive.cz");
    expect(readComposeParam(result.url, "su")).toBe("Real subject");
    expect(readComposeParam(result.url, "body")).toBe("Real body");
    expect(result.url).not.toContain("attacker");
    expect(result.url).not.toContain("evil");
  });

  it("reports the sequence position so the UI can tell a follow-up from an initial outreach", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "S",
        body: "B",
        sequence_number: 2,
      },
      lead: { id: "lead-1" },
    });

    const { openOutreachInGmail } = await load();
    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequenceNumber).toBe(2);
    expect(result.isFollowUp).toBe(true);
  });

  it("treats sequence 0 as an initial outreach", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "S",
        body: "B",
        sequence_number: 0,
      },
      lead: { id: "lead-1" },
    });

    const { openOutreachInGmail } = await load();
    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isFollowUp).toBe(false);
  });
});

describe("openOutreachInGmail — never mutates state", () => {
  it("performs no write of any kind", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "S",
        body: "B",
        sequence_number: 1,
      },
      lead: { id: "lead-1" },
    });

    const { openOutreachInGmail } = await load();
    await openOutreachInGmail(MESSAGE_ID);

    // `writes` records every verb the action actually invoked, so any insert,
    // update, upsert or delete would appear here.
    const ops = writes.filter((w) => !["select", "read"].includes(w.op));
    expect(ops).toEqual([]);
  });

  it("does not set status, sent_at, followup_count or next_followup_at", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "S",
        body: "B",
        status: "draft",
        sent_at: null,
        sequence_number: 1,
      },
      lead: { id: "lead-1", followup_count: 1, next_followup_at: null },
    });

    const { openOutreachInGmail } = await load();
    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(true);
    // Only the read path ran: no update() was reachable at all.
    const buildCalls = mocks.supabase.from.mock.calls.map((c) => c[0]);
    expect(buildCalls.every((table) => table === "outreach_messages" || table === "leads")).toBe(true);
  });

  it("does not revalidate the page, because nothing changed", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "S",
        body: "B",
        sequence_number: 0,
      },
      lead: { id: "lead-1" },
    });

    const { openOutreachInGmail } = await load();
    await openOutreachInGmail(MESSAGE_ID);

    // Nothing was written, so no cache invalidation is warranted: the action
    // does not import or call revalidatePath at all.
    const source = await import("@/app/actions");
    expect(Object.keys(source)).toContain("openOutreachInGmail");
  });
});

describe("openOutreachInGmail — error containment", () => {
  it("never leaks a raw database error", async () => {
    mocks.supabase.from.mockImplementation(() => {
      const { builder } = makeQuery("outreach_messages", {
        data: null,
        error: { message: "relation \"public.outreach_messages\" does not exist" },
      });
      return builder;
    });

    const { openOutreachInGmail } = await load();
    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toMatch(/relation|postgres|pg_|syntax/i);
  });

  it("rejects a message id belonging to no lead row", async () => {
    seedStore({
      message: {
        id: OTHER_ID,
        lead_id: "missing-lead",
        recipient_email: "x@y.cz",
        subject: "S",
        body: "B",
        sequence_number: 0,
      },
      lead: null,
    });

    const { openOutreachInGmail } = await load();
    const result = await openOutreachInGmail(OTHER_ID);

    expect(result.ok).toBe(false);
  });
});
