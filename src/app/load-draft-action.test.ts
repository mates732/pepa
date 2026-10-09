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
          maybeSingle: vi.fn(),
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
  createDraft: vi.fn(),
}));

import { normalizeEmail, isValidEmail } from "@/lib/email";
import { createDraft } from "@/lib/services/outreach-service";

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
    vi.mocked(createDraft).mockResolvedValue({
      ok: true,
      data: {
        lead: { id: "lead-1", email: "info@test.cz", company_name: null, contact_name: null, status: "draft", created_at: "", updated_at: "", last_contacted_at: null, next_followup_at: null, followup_count: 0 },
        main: { id: "msg-1", lead_id: "lead-1", recipient_email: "info@test.cz", subject: "Updated", body: "Updated body", status: "draft", provider: null, provider_message_id: null, sent_at: null, created_at: "", sequence_number: 0, parent_message_id: null },
        followUp: null,
        followUps: [],
        created: false,
      },
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

  it("calls createDraft with correct parameters", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");

    await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Updated Subject",
      body: "Updated body",
    });

    expect(createDraft).toHaveBeenCalledWith({
      recipientEmail: "info@test.cz",
      mainSubject: "Updated Subject",
      mainBody: "Updated body",
      followUps: [],
      messageId: "main_msg-1",
    });
  });

  it("returns updated message on success", async () => {
    vi.mocked(isValidEmail).mockReturnValue(true);
    vi.mocked(normalizeEmail).mockReturnValue("info@test.cz");
    vi.mocked(createDraft).mockResolvedValue({
      ok: true,
      data: {
        lead: { id: "lead-1", email: "info@test.cz", company_name: null, contact_name: null, status: "draft", created_at: "", updated_at: "", last_contacted_at: null, next_followup_at: null, followup_count: 0 },
        main: { id: "msg-1", lead_id: "lead-1", recipient_email: "info@test.cz", subject: "Updated", body: "Updated body", status: "draft", provider: null, provider_message_id: null, sent_at: null, created_at: "", sequence_number: 0, parent_message_id: null },
        followUp: null,
        followUps: [],
        created: false,
      },
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
});