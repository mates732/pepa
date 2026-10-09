import { describe, expect, it, vi, beforeEach } from "vitest";

import { loadDraftById } from "@/app/load-draft-action";
import { updateDraft } from "@/app/update-draft-action";

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          neq: vi.fn(() => ({
            maybeSingle: vi.fn(),
          })),
          maybeSingle: vi.fn(),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            maybeSingle: vi.fn(),
          })),
        })),
      })),
    })),
  })),
}));

vi.mock("@/lib/email", () => ({
  normalizeEmail: vi.fn((email: string) => email.toLowerCase().trim()),
  isValidEmail: vi.fn((email: string) => email.includes("@") && email.includes(".")),
}));

vi.mock("@/lib/services/outreach-service", () => ({
  updateMessage: vi.fn(),
  createDraft: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { normalizeEmail, isValidEmail } from "@/lib/email";
import { updateMessage, createDraft } from "@/lib/services/outreach-service";

describe("loadDraftById — server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid message ID", async () => {
    const result = await loadDraftById("invalid-id");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("identified");
  });

  it("rejects empty message ID", async () => {
    const result = await loadDraftById("");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("identified");
  });
});

describe("updateDraft — server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateMessage).mockResolvedValue({
      ok: true,
      data: {
        id: "msg-1",
        lead_id: "lead-1",
        recipient_email: "info@test.cz",
        subject: "Updated",
        body: "Updated body",
        status: "draft",
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "",
        sequence_number: 0,
        parent_message_id: null,
      },
      error: null,
    });
    vi.mocked(normalizeEmail).mockImplementation((e: string) => e.toLowerCase().trim());
    vi.mocked(isValidEmail).mockReturnValue(true);
  });

  it("validates required fields", async () => {
    // Test missing messageId
    let result = await updateDraft({ messageId: "", recipientEmail: "info@test.cz", subject: "Subject", body: "Body" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("message ID is required");

    // Test missing recipient
    result = await updateDraft({ messageId: "msg-1", recipientEmail: "", subject: "Subject", body: "Body" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("recipient email is required");

    // Test invalid email
    vi.mocked(isValidEmail).mockReturnValue(false);
    result = await updateDraft({ messageId: "msg-1", recipientEmail: "invalid", subject: "Subject", body: "Body" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("valid email address");

    // Test missing subject
    vi.mocked(isValidEmail).mockReturnValue(true);
    result = await updateDraft({ messageId: "msg-1", recipientEmail: "info@test.cz", subject: "", body: "Body" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("subject is required");

    // Test missing body
    result = await updateDraft({ messageId: "msg-1", recipientEmail: "info@test.cz", subject: "Subject", body: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("body is required");
  });

  it("calls updateMessage with correct parameters", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");

    await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Updated Subject",
      body: "Updated body",
    });

    expect(updateMessage).toHaveBeenCalledWith({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Updated Subject",
      body: "Updated body",
    });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("returns updated message on success", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");
    vi.mocked(updateMessage).mockReset();
    vi.mocked(updateMessage).mockResolvedValue({
      ok: true,
      data: {
        id: "msg-1",
        lead_id: "lead-1",
        recipient_email: "info@test.cz",
        subject: "Updated",
        body: "Updated body",
        status: "draft",
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "",
        sequence_number: 0,
        parent_message_id: null,
      },
      error: null,
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Updated Subject",
      body: "Updated body",
    });

    expect(result.ok).toBe(true);
    expect(result.message.id).toBe("msg-1");
    expect(result.message.recipient_email).toBe("info@test.cz");
    expect(result.message.subject).toBe("Updated");
    expect(result.message.body).toBe("Updated body");
  });

  it("returns error when updateMessage fails", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");
    vi.mocked(updateMessage).mockResolvedValue({
      ok: false,
      error: "Draft not found.",
      data: null,
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Updated Subject",
      body: "Updated body",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Draft not found.");
  });

  it("editing only subject preserves recipient and body", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");
    vi.mocked(updateMessage).mockResolvedValue({
      ok: true,
      data: {
        id: "msg-1",
        lead_id: "lead-1",
        recipient_email: "info@test.cz",
        subject: "New Subject Only",
        body: "Original body",
        status: "draft",
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "",
        sequence_number: 0,
        parent_message_id: null,
      },
      error: null,
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "New Subject Only",
      body: "Original body",
    });

    expect(result.ok).toBe(true);
    expect(result.message.subject).toBe("New Subject Only");
    expect(result.message.body).toBe("Original body");
    expect(result.message.recipient_email).toBe("info@test.cz");
  });

  it("editing only body preserves recipient and subject", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");
    vi.mocked(updateMessage).mockResolvedValue({
      ok: true,
      data: {
        id: "msg-1",
        lead_id: "lead-1",
        recipient_email: "info@test.cz",
        subject: "Original subject",
        body: "New body only",
        status: "draft",
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "",
        sequence_number: 0,
        parent_message_id: null,
      },
      error: null,
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Original subject",
      body: "New body only",
    });

    expect(result.ok).toBe(true);
    expect(result.message.body).toBe("New body only");
    expect(result.message.subject).toBe("Original subject");
    expect(result.message.recipient_email).toBe("info@test.cz");
  });

  it("editing recipient changes recipient but preserves other fields", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("new@test.cz");
    vi.mocked(updateMessage).mockResolvedValue({
      ok: true,
      data: {
        id: "msg-1",
        lead_id: "lead-1",
        recipient_email: "new@test.cz",
        subject: "Original subject",
        body: "Original body",
        status: "draft",
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "",
        sequence_number: 0,
        parent_message_id: null,
      },
      error: null,
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "new@test.cz",
      subject: "Original subject",
      body: "Original body",
    });

    expect(result.ok).toBe(true);
    expect(result.message.recipient_email).toBe("new@test.cz");
    expect(result.message.subject).toBe("Original subject");
    expect(result.message.body).toBe("Original body");
  });

  it("original message ID remains unchanged after edit", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");
    vi.mocked(updateMessage).mockResolvedValue({
      ok: true,
      data: {
        id: "msg-1",
        lead_id: "lead-1",
        recipient_email: "info@test.cz",
        subject: "Updated",
        body: "Updated body",
        status: "draft",
        provider: null,
        provider_message_id: null,
        sent_at: null,
        created_at: "",
        sequence_number: 0,
        parent_message_id: null,
      },
      error: null,
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Updated",
      body: "Updated body",
    });

    expect(result.ok).toBe(true);
    expect(result.message.id).toBe("msg-1");
  });

  it("returns conflict error when recipient conflicts with existing draft", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("conflict@test.cz");
    vi.mocked(updateMessage).mockResolvedValue({
      ok: false,
      error: "A draft for this recipient already exists at sequence 0.",
      data: null,
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "conflict@test.cz",
      subject: "Subject",
      body: "Body",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
  });
});