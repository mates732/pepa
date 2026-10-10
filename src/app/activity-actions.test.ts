import { beforeEach, describe, expect, it, vi } from "vitest";

import { readComposeParam } from "@/lib/outreach/gmail-compose";

/**
 * Tests for the Outreach Activity actions.
 *
 * The properties under test are all boundary properties:
 *
 *   1. an unauthenticated request is rejected before any Supabase access;
 *   2. a malformed id never reaches the database;
 *   3. Activity performs no writes of any kind — it is an audit surface, so it
 *      must have no mutation path to exercise;
 *   4. the Gmail hand-off resolves its content from the stored row, so the
 *      client cannot supply its own recipient, subject or body, and opening it
 *      changes nothing.
 */

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  supabase: { from: vi.fn() },
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

let writes: string[] = [];

/** Query-builder fake that records every mutation it is asked to perform. */
function makeQuery(table: string, result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};

  // Recorded at CALL time, so a mutation only appears once it is actually run.
  const record = (op: string) => () => {
    writes.push(`${table}.${op}`);
    return builder;
  };

  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => builder;
  builder.limit = () => builder;
  builder.maybeSingle = async () => ({ data: result.data, error: result.error });
  builder.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve(onFulfilled({ data: result.data, error: result.error }));

  builder.insert = record("INSERT");
  builder.update = record("UPDATE");
  builder.upsert = record("UPSERT");
  builder.delete = record("DELETE");

  return builder;
}

function seedStore(options: {
  message?: Record<string, unknown> | null;
  lead?: Record<string, unknown> | null;
  list?: Array<Record<string, unknown>> | null;
}) {
  const message = "message" in options ? options.message : null;
  const list = options.list ?? null;
  const lead = "lead" in options ? options.lead : { id: "lead-1" };

  mocks.supabase.from.mockImplementation((table: string) => {
    // One builder serves both shapes: the list query resolves through `then`,
    // the detail query through `maybeSingle`, and neither distinguishes them.
    return makeQuery(table, {
      data: table === "leads" ? lead : (list ?? message),
      error: null,
    });
  });
}

async function load() {
  return import("@/app/activity-actions");
}

beforeEach(() => {
  writes = [];
  mocks.requireAuthenticatedUser.mockReset();
  mocks.supabase.from.mockReset();
  mocks.requireAuthenticatedUser.mockResolvedValue({ id: "owner", since: 0 });
});

describe("activity actions — authentication", () => {
  it("rejects an unauthenticated list request before touching the database", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));

    const { loadOutreachActivity } = await load();
    await expect(loadOutreachActivity()).rejects.toThrow("AuthenticationError");

    expect(mocks.supabase.from).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated detail request before touching the database", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));

    const { loadOutreachActivityDetail } = await load();
    await expect(loadOutreachActivityDetail(MESSAGE_ID)).rejects.toThrow("AuthenticationError");

    expect(mocks.supabase.from).not.toHaveBeenCalled();
  });

  it("rejects a malformed id without querying", async () => {
    const { loadOutreachActivityDetail } = await load();

    for (const bad of ["", "not-a-uuid", "1; drop table outreach_messages"]) {
      const result = await loadOutreachActivityDetail(bad);
      expect(result.ok).toBe(false);
    }

    expect(mocks.supabase.from).not.toHaveBeenCalled();
  });

  it("never leaks a raw database error", async () => {
    mocks.supabase.from.mockImplementation(() =>
      makeQuery("outreach_messages", {
        data: null,
        error: { message: 'relation "public.outreach_messages" does not exist' },
      }),
    );

    const { loadOutreachActivity } = await load();
    const result = await loadOutreachActivity();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toMatch(/relation|postgres|pg_|syntax/i);
  });
});

describe("activity actions — the window is described honestly", () => {
  it("reports the window size and whether older sends may exist", async () => {
    seedStore({ list: [] });

    const { loadOutreachActivity } = await load();
    const result = await loadOutreachActivity();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.limit).toBe(100);
    expect(result.truncated).toBe(false);
    expect(result.activity).toEqual([]);
  });

  it("marks a full window as truncated rather than implying completeness", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, lead_id: "lead-1" }));
    seedStore({ list: rows });

    const { loadOutreachActivity } = await load();
    const result = await loadOutreachActivity();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
  });
});

describe("activity actions — read-only by construction", () => {
  it("performs no write for the list", async () => {
    seedStore({ list: [] });

    const { loadOutreachActivity } = await load();
    await loadOutreachActivity();

    expect(writes).toEqual([]);
  });

  it("performs no write for the detail", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "Nabídka",
        body: "Text.",
        status: "sent",
        sent_at: "2026-10-03T09:14:00.000Z",
        sequence_number: 1,
        parent_message_id: null,
      },
      lead: { id: "lead-1" },
    });

    const { loadOutreachActivityDetail } = await load();
    await loadOutreachActivityDetail(MESSAGE_ID);

    expect(writes).toEqual([]);
  });

  it("exposes no mutation action", async () => {
    const source = await import("@/app/activity-actions");

    // Activity has no mark-unsent, no delete and no edit. A control that does
    // not exist cannot be clicked by a crafted request either.
    expect(Object.keys(source).sort()).toEqual(["loadOutreachActivity", "loadOutreachActivityDetail"]);
    for (const name of Object.keys(source)) {
      expect(name).not.toMatch(/update|delete|save|send|unsent|edit|create/i);
    }
  });
});

describe("activity — Gmail hand-off", () => {
  it("builds the compose URL from stored content, and writes nothing", async () => {
    seedStore({
      message: {
        id: MESSAGE_ID,
        lead_id: "lead-1",
        recipient_email: "info@thearchive.cz",
        subject: "Navazuji na příspěvek",
        body: "Dobrý den,\n\ntext.\n\nS pozdravem",
        status: "sent",
        sent_at: "2026-10-03T09:14:00.000Z",
        sequence_number: 1,
        parent_message_id: null,
      },
      lead: { id: "lead-1" },
    });

    // Same Phase 4 action the rest of the dashboard uses. The browser sends only
    // an id, so there is nowhere to inject recipient, subject or body.
    const { openOutreachInGmail } = await import("@/app/actions");
    const result = await openOutreachInGmail(MESSAGE_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readComposeParam(result.webUrl, "to")).toBe("info@thearchive.cz");
    expect(readComposeParam(result.webUrl, "su")).toBe("Navazuji na příspěvek");
    expect(readComposeParam(result.webUrl, "body")).toBe("Dobrý den,\n\ntext.\n\nS pozdravem");
    expect(result.sequenceNumber).toBe(1);

    // Opening Gmail is not sending: no status, sent_at, counter or schedule moved.
    expect(writes).toEqual([]);
  });

  it("rejects an unauthenticated Gmail hand-off before querying", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));

    const { openOutreachInGmail } = await import("@/app/actions");
    await expect(openOutreachInGmail(MESSAGE_ID)).rejects.toThrow("AuthenticationError");
    expect(mocks.supabase.from).not.toHaveBeenCalled();
  });
});