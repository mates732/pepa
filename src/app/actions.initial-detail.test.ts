import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for `loadInitialOutreachDetail` — the Phase 8F follow-up entry point.
 *
 * The gap it closes: the Follow-ups workspace lists only `sequence_number > 0`,
 * so a lead whose newest row was the sequence-0 draft had no route to a
 * follow-up detail, and therefore no route to the "Next follow-up" form. The
 * other entries (the Telegram deep link, mark-as-sent) require an action the
 * operator may not want to take just to draft the next email.
 *
 * The properties under test are the ones that make it safe to wire into the
 * history table:
 *   * a session is required, and the guard runs before any database access;
 *   * the browser names a LEAD, never a message — the database decides which
 *     row is that lead's sequence head, so a crafted request cannot open an
 *     arbitrary message;
 *   * the detail itself is produced by the existing `getFollowUpDetail()`, not
 *     reassembled here, so the chain and every other rule stay in one place;
 *   * it is read-only: no insert, update or upsert is reachable, and no row is
 *     fabricated when the lead has nothing stored;
 *   * nothing is notified: no transport, no cache invalidation.
 */

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getFollowUpDetail: vi.fn(),
  listFollowUps: vi.fn(),
  sendTelegramMessage: vi.fn(),
  revalidatePath: vi.fn(),
  filters: [] as Array<[string, unknown]>,
  writes: [] as string[],
  row: null as { id: string } | null,
  readError: null as { message: string } | null,
}));

vi.mock("server-only", () => ({}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

// Everything else actions.ts pulls in is irrelevant here and would drag the
// Supabase client into the test graph.
vi.mock("@/lib/services/lead-service", () => ({ findLeadByEmail: vi.fn() }));
vi.mock("@/lib/services/outreach-service", () => ({
  createDraft: vi.fn(),
  recordOutreachSent: vi.fn(),
}));
vi.mock("@/lib/services/outreach-quality-gate", () => ({ evaluateDraftQualityGate: vi.fn() }));

vi.mock("@/lib/telegram/client", () => ({ sendTelegramMessage: mocks.sendTelegramMessage }));

vi.mock("@/lib/services/follow-up-sequence-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/services/follow-up-sequence-service",
  );
  return {
    ...actual,
    getFollowUpDetail: mocks.getFollowUpDetail,
    listFollowUps: mocks.listFollowUps,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => {
      mocks.filters.push([column, value]);
      return builder;
    };
    builder.maybeSingle = async () =>
      mocks.readError
        ? { data: null, error: mocks.readError }
        : { data: mocks.row, error: null };

    // Any write verb is a failure: this action must be incapable of one.
    const forbid = (verb: string) => () => {
      mocks.writes.push(verb);
      throw new Error(`unexpected write: ${verb}`);
    };
    builder.insert = forbid("insert");
    builder.update = forbid("update");
    builder.upsert = forbid("upsert");
    builder.delete = forbid("delete");

    return { from: () => builder };
  },
}));

const LEAD = "11111111-1111-1111-1111-111111111111";
const INITIAL = "99999999-9999-4999-8999-999999999999";

function detail(messageId: string, sequenceNumber: number) {
  return {
    lead: {
      id: LEAD,
      email: "info@thearchive.cz",
      company_name: "The Archive",
      contact_name: null,
      status: "ready",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      last_contacted_at: null,
      next_followup_at: null,
      followup_count: 0,
    },
    message: {
      id: messageId,
      lead_id: LEAD,
      recipient_email: "info@thearchive.cz",
      subject: "AI recepce pro The Archive",
      body: "Text",
      status: "draft",
      provider: null,
      provider_message_id: null,
      sent_at: null,
      created_at: "2026-10-04T10:00:00.000Z",
      sequence_number: sequenceNumber,
      parent_message_id: null,
    },
    initial: null,
    parent: null,
    isInitial: sequenceNumber === 0,
    unrecordedHistory: false,
  };
}

async function load() {
  return import("@/app/actions");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.filters = [];
  mocks.writes = [];
  mocks.row = { id: INITIAL };
  mocks.readError = null;
  mocks.requireAuthenticatedUser.mockResolvedValue({ id: "owner", since: 0 });
  mocks.getFollowUpDetail.mockResolvedValue({ ok: true, data: detail(INITIAL, 0), error: null });
});

describe("loadInitialOutreachDetail — authentication", () => {
  it("rejects an unauthenticated request before touching the database", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("Not authenticated."));
    const { loadInitialOutreachDetail } = await load();

    await expect(loadInitialOutreachDetail({ leadId: LEAD })).rejects.toThrow(
      /not authenticated/i,
    );

    expect(mocks.filters).toHaveLength(0);
    expect(mocks.getFollowUpDetail).not.toHaveBeenCalled();
  });
});

describe("loadInitialOutreachDetail — the lead is resolved, not the message", () => {
  it("asks the database for that lead's sequence-0 row", async () => {
    const { loadInitialOutreachDetail } = await load();
    await loadInitialOutreachDetail({ leadId: LEAD });

    expect(mocks.filters).toEqual([
      ["lead_id", LEAD],
      ["sequence_number", 0],
    ]);
  });

  it("opens the detail of the message the database returned", async () => {
    const { loadInitialOutreachDetail } = await load();
    const result = await loadInitialOutreachDetail({ leadId: LEAD });

    // The message id comes from the row, never from the request.
    expect(mocks.getFollowUpDetail).toHaveBeenCalledWith(INITIAL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detail.message.id).toBe(INITIAL);
      expect(result.detail.isInitial).toBe(true);
      expect(result.detail.message.sequence_number).toBe(0);
    }
  });

  it.each(["", "   ", "not-a-uuid", "../../etc/passwd", "'; drop table leads; --"])(
    "refuses a malformed lead id (%s) without querying",
    async (bad) => {
      const { loadInitialOutreachDetail } = await load();
      const result = await loadInitialOutreachDetail({ leadId: bad });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("That lead could not be identified.");
      expect(mocks.filters).toHaveLength(0);
    },
  );
});

describe("loadInitialOutreachDetail — nothing is fabricated", () => {
  it("fails honestly when the lead has no stored sequence-0 row", async () => {
    mocks.row = null;
    const { loadInitialOutreachDetail } = await load();

    const result = await loadInitialOutreachDetail({ leadId: LEAD });

    expect(result).toEqual({
      ok: false,
      error: "That lead has no initial outreach stored yet.",
    });
    // No placeholder detail, and no attempt to invent a message.
    expect(mocks.getFollowUpDetail).not.toHaveBeenCalled();
  });

  it("fails when the read itself errors", async () => {
    mocks.readError = { message: "connection reset" };
    const { loadInitialOutreachDetail } = await load();

    const result = await loadInitialOutreachDetail({ leadId: LEAD });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("That initial outreach could not be loaded.");
  });

  it("fails when the stored id is not a usable message id", async () => {
    mocks.row = { id: "garbage" };
    const { loadInitialOutreachDetail } = await load();

    const result = await loadInitialOutreachDetail({ leadId: LEAD });
    expect(result.ok).toBe(false);
    expect(mocks.getFollowUpDetail).not.toHaveBeenCalled();
  });

  it("surfaces the service's own refusal rather than inventing a detail", async () => {
    mocks.getFollowUpDetail.mockResolvedValue({
      ok: false,
      data: null,
      error: "That follow-up could not be loaded.",
    });
    const { loadInitialOutreachDetail } = await load();

    const result = await loadInitialOutreachDetail({ leadId: LEAD });
    expect(result).toEqual({ ok: false, error: "That follow-up could not be loaded." });
  });
});

describe("loadInitialOutreachDetail — read-only, and silent", () => {
  it("performs no write and notifies nobody", async () => {
    const { loadInitialOutreachDetail } = await load();
    await loadInitialOutreachDetail({ leadId: LEAD });

    expect(mocks.writes).toEqual([]);
    expect(mocks.sendTelegramMessage).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not disturb the follow-up workspace listing", async () => {
    const { loadInitialOutreachDetail } = await load();
    await loadInitialOutreachDetail({ leadId: LEAD });

    expect(mocks.listFollowUps).not.toHaveBeenCalled();
  });
});
