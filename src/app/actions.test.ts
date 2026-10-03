import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/token";

const mocks = vi.hoisted(() => ({
  findLeadByEmail: vi.fn(),
  createDraft: vi.fn(),
  recordOutreachSent: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/services/lead-service", () => ({
  findLeadByEmail: mocks.findLeadByEmail,
}));
vi.mock("@/lib/services/outreach-service", () => ({
  createDraft: mocks.createDraft,
  recordOutreachSent: mocks.recordOutreachSent,
}));

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) } : undefined,
  }),
  headers: async () => new Headers(),
}));

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

const LEAD = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "info@example.com",
  company_name: "Example",
  contact_name: null,
  status: "ready" as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_contacted_at: null,
  next_followup_at: null,
  followup_count: 0,
};

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
  cookieStore.clear();
  mocks.findLeadByEmail.mockReset();
  mocks.createDraft.mockReset();
  mocks.recordOutreachSent.mockReset();
  mocks.revalidatePath.mockReset();

  mocks.findLeadByEmail.mockResolvedValue({
    ok: true,
    error: null,
    data: {
      state: "new",
      normalizedEmail: "info@example.com",
      lead: null,
      messageCount: 0,
      sentCount: 0,
      lastContactedAt: null,
    },
  });
  mocks.createDraft.mockResolvedValue({
    ok: true,
    error: null,
    data: {
      lead: LEAD,
      message: {
        id: "22222222-2222-2222-2222-222222222222",
        lead_id: LEAD.id,
        recipient_email: LEAD.email,
        subject: "Test subject",
        body: "Test body",
        status: "draft" as const,
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      created: true,
    },
  });
});

async function loadActions() {
  return import("@/app/actions");
}

describe("checkRecipient (privileged server action)", () => {
  it("is rejected when unauthenticated and never reaches the database", async () => {
    const { checkRecipient } = await loadActions();

    await expect(checkRecipient("info@example.com")).rejects.toThrow("Not authenticated.");
    expect(mocks.findLeadByEmail).not.toHaveBeenCalled();
  });

  it("is rejected when the session cookie is forged", async () => {
    cookieStore.set(SESSION_COOKIE, "v1.forged.signature");
    const { checkRecipient } = await loadActions();

    await expect(checkRecipient("info@example.com")).rejects.toThrow("Not authenticated.");
    expect(mocks.findLeadByEmail).not.toHaveBeenCalled();
  });

  it("is rejected when the session has expired", async () => {
    cookieStore.set(
      SESSION_COOKIE,
      createSessionToken(Date.now() - 60 * 60 * 24 * 40 * 1000),
    );
    const { checkRecipient } = await loadActions();

    await expect(checkRecipient("info@example.com")).rejects.toThrow("Not authenticated.");
    expect(mocks.findLeadByEmail).not.toHaveBeenCalled();
  });

  it("is allowed for an authenticated operator", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { checkRecipient } = await loadActions();

    const result = await checkRecipient(" Info@Example.com ");
    expect(result.ok).toBe(true);
    expect(mocks.findLeadByEmail).toHaveBeenCalledWith("info@example.com");
  });
});

describe("saveDraft (privileged server action)", () => {
  const input = {
    recipientEmail: "info@example.com",
    subject: "Test subject",
    body: "Test body",
  };

  it("is rejected when unauthenticated and never writes to the database", async () => {
    const { saveDraft } = await loadActions();

    await expect(saveDraft(input)).rejects.toThrow("Not authenticated.");
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("is allowed for an authenticated operator", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { saveDraft } = await loadActions();

    const result = await saveDraft(input);
    expect(result).toMatchObject({ ok: true, lead: { email: "info@example.com" } });
    expect(mocks.createDraft).toHaveBeenCalledOnce();
  });

  it("validates input before touching the database", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { saveDraft } = await loadActions();

    await expect(saveDraft({ ...input, recipientEmail: "nope" })).resolves.toMatchObject({
      ok: false,
    });
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });
});

describe("recordOutreachSent (privileged server action)", () => {
  const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";

  const sentMessage = {
    id: MESSAGE_ID,
    lead_id: LEAD.id,
    recipient_email: "info@example.com",
    subject: "Test subject",
    body: "Test body",
    status: "sent" as const,
    provider: null,
    provider_message_id: null,
    sent_at: "2026-03-01T10:00:00.000Z",
    created_at: "2026-02-01T00:00:00.000Z",
  };

  beforeEach(() => {
    mocks.recordOutreachSent.mockResolvedValue({
      ok: true,
      error: null,
      data: { outcome: "recorded", message: sentMessage, nextFollowUpAt: "2026-03-05T10:00:00.000Z" },
    });
  });

  it("is rejected when unauthenticated and never records a send", async () => {
    const { recordOutreachSent } = await loadActions();

    await expect(
      recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD.id }),
    ).rejects.toThrow("Not authenticated.");
    expect(mocks.recordOutreachSent).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("validates both ids before touching the database", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { recordOutreachSent } = await loadActions();

    await expect(
      recordOutreachSent({ messageId: "not-a-uuid", leadId: LEAD.id }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      recordOutreachSent({ messageId: MESSAGE_ID, leadId: "not-a-uuid" }),
    ).resolves.toMatchObject({ ok: false });
    expect(mocks.recordOutreachSent).not.toHaveBeenCalled();
  });

  it("records the send and refreshes the dashboard for an authenticated operator", async () => {
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { recordOutreachSent } = await loadActions();

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD.id });

    expect(result).toMatchObject({ ok: true, outcome: "recorded", nextFollowUpAt: "2026-03-05T10:00:00.000Z" });
    expect(mocks.recordOutreachSent).toHaveBeenCalledWith({ messageId: MESSAGE_ID, leadId: LEAD.id });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/");
  });

  it("does not hand out a schedule for an idempotent repeat", async () => {
    mocks.recordOutreachSent.mockResolvedValueOnce({
      ok: true,
      error: null,
      data: { outcome: "already_sent", message: sentMessage, nextFollowUpAt: "2026-03-05T10:00:00.000Z" },
    });
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { recordOutreachSent } = await loadActions();

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD.id });

    // Reporting a fresh schedule here would imply a follow-up was queued again.
    expect(result).toMatchObject({ ok: true, outcome: "already_sent", nextFollowUpAt: null });
  });

  it("surfaces a rejected message/lead pairing as a failure", async () => {
    mocks.recordOutreachSent.mockResolvedValueOnce({
      ok: false,
      error: "That message does not exist for this lead.",
      data: null,
    });
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { recordOutreachSent } = await loadActions();

    const result = await recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD.id });

    expect(result).toMatchObject({
      ok: false,
      error: "That message does not exist for this lead.",
    });
  });

  it("turns a thrown service error into a failure instead of crashing the action", async () => {
    mocks.recordOutreachSent.mockRejectedValueOnce(new Error("connection reset"));
    cookieStore.set(SESSION_COOKIE, createSessionToken());
    const { recordOutreachSent } = await loadActions();

    await expect(
      recordOutreachSent({ messageId: MESSAGE_ID, leadId: LEAD.id }),
    ).resolves.toMatchObject({ ok: false, error: "connection reset" });
  });
});