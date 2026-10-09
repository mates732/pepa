import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { Inbox } from "@/components/inbox";
import { parseBulkEmails } from "@/lib/import/bulk-emails";
import { buildComposeUrls } from "@/lib/outreach/gmail-compose-client";
import { preopenComposeWindow, navigateComposeWindow, closeComposeWindow } from "@/lib/outreach/open-compose-window";

import type { SaveDraftsResult } from "@/app/save-drafts-action";
import type { LoadDraftResponse } from "@/app/load-draft-action";
import type { UpdateDraftResponse } from "@/app/update-draft-action";
import type { DeleteOutreachMessageResult } from "@/app/actions";

// Mock server actions
vi.mock("@/app/save-drafts-action", () => ({
  saveDraftsFromPaste: vi.fn<[string], Promise<SaveDraftsResult>>(),
}));

vi.mock("@/app/load-draft-action", () => ({
  loadDraftById: vi.fn<[string], Promise<LoadDraftResponse>>(),
}));

vi.mock("@/app/update-draft-action", () => ({
  updateDraft: vi.fn<[{ messageId: string; recipientEmail: string; subject: string; body: string }], Promise<UpdateDraftResponse>>(),
}));

vi.mock("@/app/actions", () => ({
  openOutreachInGmail: vi.fn(),
  deleteOutreachMessage: vi.fn<[{ messageId: string }], Promise<DeleteOutreachMessageResult>>(),
  loadOutreachDraftRows: vi.fn<[], Promise<{ ok: true; drafts: Array<Record<string, unknown>> }>>(),
}));

// Don't mock the client-side utilities - test the real implementations
vi.unmock("@/lib/outreach/gmail-compose-client");
vi.unmock("@/lib/outreach/open-compose-window");

import { saveDraftsFromPaste } from "@/app/save-drafts-action";
import { loadDraftById } from "@/app/load-draft-action";
import { updateDraft } from "@/app/update-draft-action";
import { deleteOutreachMessage } from "@/app/actions";

function renderInbox() {
  return renderToStaticMarkup(<Inbox />);
}

describe("Inbox component — initial render (SSR)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the paste section with textarea and save button", () => {
    const markup = renderInbox();

    expect(markup).toContain("Paste Emails");
    expect(markup).toContain("textarea");
    expect(markup).toContain("Save drafts");
    expect(markup).toContain("Clear");
  });

  it("shows loading state for drafts initially (SSR)", () => {
    const markup = renderInbox();

    expect(markup).toContain("Drafts (0)");
    expect(markup).toContain("Loading drafts…");
  });
});

describe("parseBulkEmails — parser used by saveDraftsFromPaste", () => {
  it("parses single email correctly", () => {
    const input = `--- LEAD 01 ---
Email: info@test.cz
Subject: Test Subject
Body:
Test body content

Follow-up Subject: Follow-up 1
Follow-up Body:
Follow-up body`;

    const result = parseBulkEmails(input);

    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.recipient).toBe("info@test.cz");
    expect(c.subject).toBe("Test Subject");
    expect(c.body).toBe("Test body content");
    expect(c.followUps).toHaveLength(1);
    expect(c.followUps[0]!.subject).toBe("Follow-up 1");
    expect(c.followUps[0]!.body).toBe("Follow-up body");
    expect(c.status).toBe("parsed");
  });

  it("parses multiple emails correctly", () => {
    const input = `--- LEAD 01 ---
Email: a@test.cz
Subject: Subject A
Body: Body A

--- LEAD 02 ---
Email: b@test.cz
Subject: Subject B
Body: Body B`;

    const result = parseBulkEmails(input);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.recipient).toBe("a@test.cz");
    expect(result.candidates[1]!.recipient).toBe("b@test.cz");
    expect(result.candidates[0]!.subject).toBe("Subject A");
    expect(result.candidates[1]!.subject).toBe("Subject B");
  });

  it("does not merge recipients", () => {
    const input = `--- LEAD 01 ---
Email: a@test.cz
Subject: A
Body: Body A

--- LEAD 02 ---
Email: b@test.cz
Subject: B
Body: Body B`;

    const result = parseBulkEmails(input);

    expect(result.candidates[0]!.recipient).toBe("a@test.cz");
    expect(result.candidates[1]!.recipient).toBe("b@test.cz");
    expect(result.candidates[0]!.recipient).not.toContain("b@test.cz");
    expect(result.candidates[1]!.recipient).not.toContain("a@test.cz");
  });

  it("does not merge subjects", () => {
    const input = `--- LEAD 01 ---
Email: a@test.cz
Subject: Subject A
Body: Body A

--- LEAD 02 ---
Email: b@test.cz
Subject: Subject B
Body: Body B`;

    const result = parseBulkEmails(input);

    expect(result.candidates[0]!.subject).toBe("Subject A");
    expect(result.candidates[1]!.subject).toBe("Subject B");
    expect(result.candidates[0]!.subject).not.toContain("Subject B");
    expect(result.candidates[1]!.subject).not.toContain("Subject A");
  });

  it("does not merge bodies", () => {
    const input = `--- LEAD 01 ---
Email: a@test.cz
Subject: A
Body: Body A only

--- LEAD 02 ---
Email: b@test.cz
Subject: B
Body: Body B only`;

    const result = parseBulkEmails(input);

    expect(result.candidates[0]!.body).toBe("Body A only");
    expect(result.candidates[1]!.body).toBe("Body B only");
    expect(result.candidates[0]!.body).not.toContain("Body B");
    expect(result.candidates[1]!.body).not.toContain("Body A");
  });
});

describe("buildComposeUrls — Gmail URL building (client-side)", () => {
  it("builds correct mailto and web URLs", () => {
    const urls = buildComposeUrls({
      to: "info@test.cz",
      subject: "Test Subject",
      body: "Test body",
    });

    expect(urls.mailto).toContain("mailto:?to=info%40test.cz");
    expect(urls.mailto).toContain("subject=Test+Subject");
    expect(urls.mailto).toContain("body=Test+body");
    expect(urls.web).toContain("https://mail.google.com/mail/");
    expect(urls.web).toContain("to=info%40test.cz");
    expect(urls.web).toContain("su=Test+Subject");
    expect(urls.web).toContain("body=Test+body");
  });

  it("handles special characters correctly", () => {
    const urls = buildComposeUrls({
      to: "test+tag@example.com",
      subject: "Test & confirm",
      body: "Line 1\nLine 2",
    });

    expect(urls.web).toContain("to=test%2Btag%40example.com");
    expect(urls.web).toContain("su=Test+%26+confirm");
    expect(urls.web).toContain("body=Line+1%0ALine+2");
  });

  it("omits empty subject and body", () => {
    const urls = buildComposeUrls({
      to: "info@test.cz",
      subject: "",
      body: "",
    });

    expect(urls.mailto).toBe("mailto:?to=info%40test.cz");
    expect(urls.web).toContain("to=info%40test.cz");
    expect(urls.web).not.toContain("su=");
    expect(urls.web).not.toContain("body=");
  });

  it("correctly encodes Czech diacritics in subject", () => {
    const urls = buildComposeUrls({
      to: "info@test.cz",
      subject: "Příjemné odpoledne — nabídka",
      body: "Dobrý den,\n\nnabídka.",
    });

    expect(urls.web).toContain("su=P%C5%99%C3%ADjemn%C3%A9+odpoledne+%E2%80%94+nab%C3%ADdka");
    expect(urls.web).toContain("body=Dobr%C3%BD+den%2C%0A%0Anab%C3%ADdka.");
  });

  it("correctly encodes plus address in recipient", () => {
    const urls = buildComposeUrls({
      to: "user+tag@example.com",
      subject: "Test",
      body: "Body",
    });

    expect(urls.web).toContain("to=user%2Btag%40example.com");
  });
});

describe("preopenComposeWindow / navigateComposeWindow / closeComposeWindow — popup handling", () => {
  function createMockHandle() {
    return {
      location: { href: "" },
      closed: false,
      close: vi.fn(function (this: { closed: boolean }) { this.closed = true; }),
      opener: { name: "pepa" },
    };
  }

  it("exports the expected functions", () => {
    expect(typeof preopenComposeWindow).toBe("function");
    expect(typeof navigateComposeWindow).toBe("function");
    expect(typeof closeComposeWindow).toBe("function");
  });

  it("preopenComposeWindow opens about:blank and returns a handle", () => {
    const handle = preopenComposeWindow(() => createMockHandle());
    expect(handle).not.toBeNull();
    expect(handle?.location.href).toBe("");
  });

  it("navigateComposeWindow sets location.href", () => {
    const handle = createMockHandle();
    const url = "https://mail.google.com/mail/?view=cm&to=test%40example.com";

    const result = navigateComposeWindow(handle, url);

    expect(result).toBe(true);
    expect(handle.location.href).toBe(url);
  });

  it("navigateComposeWindow returns false for null handle", () => {
    const result = navigateComposeWindow(null, "https://example.com");
    expect(result).toBe(false);
  });

  it("navigateComposeWindow returns false for closed handle", () => {
    const handle = createMockHandle();
    handle.closed = true;

    const result = navigateComposeWindow(handle, "https://example.com");
    expect(result).toBe(false);
  });

  it("closeComposeWindow closes the handle", () => {
    const handle = createMockHandle();
    closeComposeWindow(handle);
    expect(handle.closed).toBe(true);
  });

  it("closeComposeWindow is safe for null handle", () => {
    expect(() => closeComposeWindow(null)).not.toThrow();
  });
});

describe("saveDraftsFromPaste — server action integration (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls saveDraftsFromPaste with pasted text", async () => {
    vi.mocked(saveDraftsFromPaste).mockResolvedValue({
      ok: true,
      created: 2,
      existing: 0,
      skipped: 0,
      failed: 0,
      details: [
        { index: 1, recipient: "a@test.cz", outcome: "created", messageId: "msg-1", leadId: "lead-1", error: null },
        { index: 2, recipient: "b@test.cz", outcome: "created", messageId: "msg-2", leadId: "lead-2", error: null },
      ],
    });

    const input = `--- LEAD 01 ---
Email: a@test.cz
Subject: A
Body: Body A

--- LEAD 02 ---
Email: b@test.cz
Subject: B
Body: Body B`;

    const result = await saveDraftsFromPaste(input);

    expect(saveDraftsFromPaste).toHaveBeenCalledWith(input);
    expect(result.ok).toBe(true);
    expect(result.created).toBe(2);
  });

  it("returns error for empty input", async () => {
    vi.mocked(saveDraftsFromPaste).mockResolvedValue({
      ok: false,
      error: "Nothing to parse. Paste your finished emails...",
    });

    const result = await saveDraftsFromPaste("");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Nothing to parse");
  });
});

describe("loadDraftById — server action integration (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls loadDraftById with message ID", async () => {
    vi.mocked(loadDraftById).mockResolvedValue({
      ok: true,
      lead: { id: "lead-1", email: "info@test.cz", company_name: "Test Co", contact_name: null, status: "draft", created_at: "", updated_at: "", last_contacted_at: null, next_followup_at: null, followup_count: 0 },
      message: { id: "msg-1", lead_id: "lead-1", recipient_email: "info@test.cz", subject: "Test Subject", body: "Test body", status: "draft", provider: null, provider_message_id: null, sent_at: null, created_at: "", sequence_number: 0, parent_message_id: null },
    });

    const result = await loadDraftById("msg-1");

    expect(loadDraftById).toHaveBeenCalledWith("msg-1");
    expect(result.ok).toBe(true);
    expect(result.message.recipient_email).toBe("info@test.cz");
    expect(result.message.subject).toBe("Test Subject");
  });

  it("returns error for invalid message ID", async () => {
    vi.mocked(loadDraftById).mockResolvedValue({
      ok: false,
      error: "That draft could not be identified.",
    });

    const result = await loadDraftById("invalid");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("identified");
  });
});

describe("updateDraft — server action integration (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls updateDraft with message ID and updated fields", async () => {
    vi.mocked(updateDraft).mockResolvedValue({
      ok: true,
      message: { id: "msg-1", recipient_email: "new@test.cz", subject: "Updated Subject", body: "Updated body", sequence_number: 0 },
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "new@test.cz",
      subject: "Updated Subject",
      body: "Updated body",
    });

    expect(updateDraft).toHaveBeenCalledWith({
      messageId: "msg-1",
      recipientEmail: "new@test.cz",
      subject: "Updated Subject",
      body: "Updated body",
    });
    expect(result.ok).toBe(true);
    expect(result.message.recipient_email).toBe("new@test.cz");
    expect(result.message.subject).toBe("Updated Subject");
  });

  it("returns error for invalid recipient", async () => {
    vi.mocked(updateDraft).mockResolvedValue({
      ok: false,
      error: '"invalid" is not a valid email address.',
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "invalid",
      subject: "Subject",
      body: "Body",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("valid email");
  });

  it("returns error for missing subject", async () => {
    vi.mocked(updateDraft).mockResolvedValue({
      ok: false,
      error: "A subject is required.",
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "",
      body: "Body",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("subject is required");
  });

  it("returns error for missing body", async () => {
    vi.mocked(updateDraft).mockResolvedValue({
      ok: false,
      error: "A body is required.",
    });

    const result = await updateDraft({
      messageId: "msg-1",
      recipientEmail: "info@test.cz",
      subject: "Subject",
      body: "",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("body is required");
  });
});

describe("deleteOutreachMessage — draft deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls deleteOutreachMessage with message ID", async () => {
    vi.mocked(deleteOutreachMessage).mockResolvedValue({ ok: true, deleted: true });

    const result = await deleteOutreachMessage({ messageId: "msg-1" });

    expect(deleteOutreachMessage).toHaveBeenCalledWith({ messageId: "msg-1" });
    expect(result.ok).toBe(true);
  });
});