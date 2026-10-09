import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";

import { openGmailCompose } from "./open-gmail-compose";

describe("openGmailCompose — shared Gmail compose helper", () => {
  const originalWindowOpen = typeof window !== "undefined" ? window.open : undefined;
  const mockWindowOpen = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - mock window for tests
    global.window = { open: mockWindowOpen };
  });

  afterAll(() => {
    if (originalWindowOpen !== undefined) {
      // @ts-expect-error - restore window for tests
      global.window = { open: originalWindowOpen };
    }
  });

  it("opens Gmail compose with correct URL and returns success", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "Test Subject",
      body: "Test body",
    });

    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining("https://mail.google.com/mail/"),
      "_blank",
      "noreferrer"
    );
    expect(result.opened).toBe(true);
    expect(result.url).toContain("https://mail.google.com/mail/");
    expect(result.message).toContain("Opened Gmail compose");
  });

  it("handles popup blocked (window.open returns null)", () => {
    mockWindowOpen.mockReturnValue(null);

    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "Test Subject",
      body: "Test body",
    });

    expect(result.opened).toBe(false);
    expect(result.message).toContain("blocked");
    expect(result.message).toContain("Open this link manually");
    expect(result.url).toContain("https://mail.google.com/mail/");
  });

  it("handles popup blocked (window.open throws)", () => {
    mockWindowOpen.mockImplementation(() => {
      throw new Error("Popup blocked");
    });

    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "Test Subject",
      body: "Test body",
    });

    expect(result.opened).toBe(false);
    expect(result.message).toContain("blocked");
  });

  it("correctly encodes Czech diacritics in subject", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "Příjemné odpoledne — nabídka",
      body: "Dobrý den,\n\nnabídka.",
    });

    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining("su=P%C5%99%C3%ADjemn%C3%A9+odpoledne+%E2%80%94+nab%C3%ADdka"),
      "_blank",
      "noreferrer"
    );
    expect(result.opened).toBe(true);
  });

  it("correctly encodes plus address in recipient", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const result = openGmailCompose({
      to: "user+tag@example.com",
      subject: "Test",
      body: "Body",
    });

    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining("to=user%2Btag%40example.com"),
      "_blank",
      "noreferrer"
    );
    expect(result.opened).toBe(true);
  });

  it("handles empty subject and body by omitting them", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "",
      body: "",
    });

    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&to=info%40test\.cz$/),
      "_blank",
      "noreferrer"
    );
    expect(result.opened).toBe(true);
  });

  it("allows custom opener function for testing", () => {
    const customOpener = vi.fn().mockReturnValue({
      opener: null,
      location: { href: "" },
      closed: false,
      close: vi.fn(),
    });

    const result = openGmailCompose(
      { to: "info@test.cz", subject: "Test", body: "Body" },
      { opener: customOpener },
    );

    expect(customOpener).toHaveBeenCalledWith(
      expect.stringContaining("https://mail.google.com/mail/"),
      "_blank",
      "noreferrer"
    );
    expect(result.opened).toBe(true);
  });

  it("allows custom success and blocked messages", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const successResult = openGmailCompose(
      { to: "info@test.cz" },
      { successMessage: "Custom success" },
    );
    expect(successResult.message).toContain("Custom success");

    mockWindowOpen.mockReturnValue(null);
    const blockedResult = openGmailCompose(
      { to: "info@test.cz" },
      { blockedMessage: "Custom blocked" },
    );
    expect(blockedResult.message).toContain("Custom blocked");
  });

  it("handles undefined body and subject gracefully", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const result = openGmailCompose({
      to: "info@test.cz",
      subject: undefined,
      body: undefined,
    });

    expect(result.opened).toBe(true);
    expect(result.url).toContain("to=info%40test.cz");
    expect(result.url).not.toContain("su=");
    expect(result.url).not.toContain("body=");
  });

  it("preserves newlines in body", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const body = "Line 1\nLine 2\n\nLine 4";
    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "Test",
      body,
    });

    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining("body=Line+1%0ALine+2%0A%0ALine+4"),
      "_blank",
      "noreferrer"
    );
    expect(result.opened).toBe(true);
  });

  it("handles ampersand in subject and body", () => {
    const mockTab = { opener: null, location: { href: "" }, closed: false, close: vi.fn() };
    mockWindowOpen.mockReturnValue(mockTab);

    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "Test & confirm",
      body: "A & B",
    });

    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining("su=Test+%26+confirm"),
      "_blank",
      "noreferrer"
    );
    expect(mockWindowOpen).toHaveBeenCalledWith(
      expect.stringContaining("body=A+%26+B"),
      "_blank",
      "noreferrer"
    );
    expect(result.opened).toBe(true);
  });
});