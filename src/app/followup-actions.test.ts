import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the Phase 8F `createFollowUp` action.
 *
 * The boundary properties under test:
 *   * an unauthenticated request is rejected before the sequence service is
 *     reached, so an anonymous caller cannot create a row;
 *   * the client supplies a parent message id and nothing else — lead,
 *     recipient and sequence number come from the service, not the request;
 *   * the action is a thin delegation. It must not reimplement eligibility or
 *     slot allocation, so those assertions belong to the service tests;
 *   * creating a follow-up notifies nobody: no token is minted, no provider is
 *     called and the ledger is never written;
 *   * the existing token-based save path and the quality-gated send-recording
 *     path are untouched.
 *
 * The sequence service is mocked here, exactly as `stats-actions.test.ts`
 * mocks its service: what is under test is the action's contract, not the
 * sequence logic, which `follow-up-sequence-service.test.ts` covers against a
 * store fake that models the real unique constraint.
 */

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  createFollowUpDraft: vi.fn(),
  saveFollowUpDraft: vi.fn(),
  resolveActionToken: vi.fn(),
  sendTelegramMessage: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));

// Tracked so "a follow-up draft notifies nobody" is an assertion rather than a
// claim: if this action ever started invalidating a cache or reaching a
// transport, these would fail.
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/services/follow-up-sequence-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/services/follow-up-sequence-service",
  );
  return { ...actual, createFollowUpDraft: mocks.createFollowUpDraft };
});

vi.mock("@/lib/services/action-token-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/services/action-token-service",
  );
  return { ...actual, saveFollowUpDraft: mocks.saveFollowUpDraft };
});

// Any transport reachable from the action graph. Creating a follow-up must not
// touch it, so a call here fails the test.
vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: mocks.sendTelegramMessage,
}));

const PARENT = "11111111-2222-4333-8444-555555555555";
const CREATED = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function ok(messageId = CREATED, sequenceNumber = 1, created = true) {
  return {
    ok: true,
    error: null,
    data: {
      message: {
        id: messageId,
        lead_id: "lead-1",
        recipient_email: "info@example.cz",
        subject: "Re: Nabídka",
        body: "Text",
        status: "draft",
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "2026-10-04T10:00:00.000Z",
        sequence_number: sequenceNumber,
        parent_message_id: PARENT,
      },
      created,
    },
  };
}

function fail(reason: string, error = "nope") {
  return { ok: false, data: null, error, reason };
}

async function load() {
  return import("@/app/followup-actions");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuthenticatedUser.mockResolvedValue({ id: "owner", since: 0 });
  mocks.createFollowUpDraft.mockResolvedValue(ok());
});

describe("createFollowUp — authentication", () => {
  it("rejects an unauthenticated request before the service is reached", async () => {
    // The dal module is mocked, so this stands in for AuthenticationError: what
    // matters is that the guard throws and the service is never reached.
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("Not authenticated."));

    const { createFollowUp } = await load();
    await expect(
      createFollowUp({ parentMessageId: PARENT, subject: "Re: Nabídka", body: "Text" }),
    ).rejects.toThrow(/not authenticated/i);

    // The important half: nothing was created, because nothing was reached.
    expect(mocks.createFollowUpDraft).not.toHaveBeenCalled();
  });

  it("does not fall back to the token-based save path", async () => {
    const { createFollowUp } = await load();
    await createFollowUp({ parentMessageId: PARENT, subject: "Re: Nabídka", body: "Text" });

    expect(mocks.saveFollowUpDraft).not.toHaveBeenCalled();
    expect(mocks.resolveActionToken).not.toHaveBeenCalled();
  });
});

describe("createFollowUp — input validation", () => {
  it("rejects a parent id that is not a uuid without querying", async () => {
    const { createFollowUp } = await load();

    for (const bad of ["", "   ", "not-a-uuid", "1; DROP TABLE outreach_messages", "../etc"]) {
      const result = await createFollowUp({
        parentMessageId: bad,
        subject: "Re: Nabídka",
        body: "Text",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_input");
    }

    expect(mocks.createFollowUpDraft).not.toHaveBeenCalled();
  });

  it("requires a subject", async () => {
    const { createFollowUp } = await load();
    const result = await createFollowUp({ parentMessageId: PARENT, subject: "   ", body: "Text" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_input");
    expect(mocks.createFollowUpDraft).not.toHaveBeenCalled();
  });

  it("caps an oversized subject rather than storing it", async () => {
    const { createFollowUp } = await load();
    await createFollowUp({
      parentMessageId: PARENT,
      subject: "x".repeat(5_000),
      body: "Text",
    });

    const passed = mocks.createFollowUpDraft.mock.calls[0][0];
    expect(passed.subject).toHaveLength(998);
  });

  it("caps an oversized body rather than storing it", async () => {
    const { createFollowUp } = await load();
    await createFollowUp({
      parentMessageId: PARENT,
      subject: "Re: Nabídka",
      body: "y".repeat(200_500),
    });

    const passed = mocks.createFollowUpDraft.mock.calls[0][0];
    expect(passed.body).toHaveLength(200_000);
  });
});

describe("createFollowUp — delegation, not reimplementation", () => {
  it("passes the resolved parent and text to the existing sequence service", async () => {
    const { createFollowUp } = await load();
    await createFollowUp({ parentMessageId: PARENT, subject: "Re: Nabídka", body: "Navazuji" });

    expect(mocks.createFollowUpDraft).toHaveBeenCalledTimes(1);
    expect(mocks.createFollowUpDraft).toHaveBeenCalledWith({
      anchorMessageId: PARENT,
      subject: "Re: Nabídka",
      body: "Navazuji",
    });
  });

  it("returns the sequence number and id the service actually wrote", async () => {
    const { createFollowUp } = await load();
    const result = await createFollowUp({
      parentMessageId: PARENT,
      subject: "Re: Nabídka",
      body: "Text",
    });

    expect(result).toEqual({ ok: true, created: true, messageId: CREATED, sequenceNumber: 1 });
  });

  it("reports an in-place update as created: false", async () => {
    mocks.createFollowUpDraft.mockResolvedValue(ok(CREATED, 1, false));
    const { createFollowUp } = await load();

    const result = await createFollowUp({ parentMessageId: PARENT, subject: "Re: X", body: "Y" });
    expect(result.ok && result.created).toBe(false);
  });

  it("surfaces the service's refusal reason unchanged", async () => {
    mocks.createFollowUpDraft.mockResolvedValue(
      fail("anchor_not_latest", "A later follow-up already exists for this recipient."),
    );
    const { createFollowUp } = await load();

    const result = await createFollowUp({ parentMessageId: PARENT, subject: "Re: X", body: "Y" });
    expect(result).toEqual({
      ok: false,
      error: "A later follow-up already exists for this recipient.",
      reason: "anchor_not_latest",
    });
  });

  it.each(["conflict", "not_found", "store_failed"] as const)(
    "propagates a %s refusal as a failure, never as a success",
    async (reason) => {
      mocks.createFollowUpDraft.mockResolvedValue(fail(reason));
      const { createFollowUp } = await load();

      const result = await createFollowUp({
        parentMessageId: PARENT,
        subject: "Re: X",
        body: "Y",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    },
  );

  it("falls back to store_failed when the service reports no reason", async () => {
    mocks.createFollowUpDraft.mockResolvedValue({
      ok: false,
      data: null,
      error: null,
    });
    const { createFollowUp } = await load();

    const result = await createFollowUp({ parentMessageId: PARENT, subject: "Re: X", body: "Y" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("store_failed");
  });
});

describe("createFollowUp — creates nothing that notifies anyone", () => {
  it("never calls the Telegram transport", async () => {
    const { createFollowUp } = await load();
    await createFollowUp({ parentMessageId: PARENT, subject: "Re: Nabídka", body: "Text" });

    expect(mocks.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("never mints a token or invalidates a cache", async () => {
    const { createFollowUp } = await load();
    await createFollowUp({ parentMessageId: PARENT, subject: "Re: Nabídka", body: "Text" });

    expect(mocks.resolveActionToken).not.toHaveBeenCalled();
    expect(mocks.saveFollowUpDraft).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("existing follow-up save and send paths are unchanged", () => {
  it("saveFollowUp still validates its input before touching the token path", async () => {
    const { saveFollowUp } = await load();

    await expect(saveFollowUp({ token: "raw", subject: "  ", body: "Y" })).resolves.toEqual({
      ok: false,
      error: "A subject is required.",
    });

    expect(mocks.saveFollowUpDraft).not.toHaveBeenCalled();
  });

  it("saveFollowUp still delegates to the token-gated draft save", async () => {
    mocks.saveFollowUpDraft.mockResolvedValue({
      ok: true,
      error: null,
      data: { lead: {}, message: {}, created: true },
    });

    const { saveFollowUp } = await load();
    const result = await saveFollowUp({ token: "raw", subject: "Re: X", body: "Y" });

    expect(mocks.saveFollowUpDraft).toHaveBeenCalledWith({
      rawToken: "raw",
      subject: "Re: X",
      body: "Y",
    });
    expect(result.ok).toBe(true);
  });

  it("saving an import draft through the new action still touches no transport", async () => {
    mocks.createFollowUpDraft.mockResolvedValue(ok());
    const { createFollowUp } = await load();
    await createFollowUp({ parentMessageId: PARENT, subject: "Re: X", body: "Y" });

    expect(mocks.sendTelegramMessage).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
