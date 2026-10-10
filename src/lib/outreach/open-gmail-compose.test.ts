import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { openGmailCompose } from "./open-gmail-compose";

describe("openGmailCompose — shared Gmail compose helper", () => {
  const originalLocationAssign = typeof window !== "undefined" && window.location?.assign ? window.location.assign.bind(window.location) : undefined;
  const mockLocationAssign = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - mock window.location for tests
    global.window = {
      location: {
        assign: mockLocationAssign,
        href: "https://pepa.example.com",
      },
    };
  });

  afterEach(() => {
    if (originalLocationAssign !== undefined) {
      // @ts-expect-error - restore window.location.assign for tests
      global.window.location.assign = originalLocationAssign;
    }
  });

  it("navigates to Gmail compose with correct URL", () => {
    const result = openGmailCompose({
      to: "info@test.cz",
      subject: "Test Subject",
      body: "Test body",
    });

    expect(mockLocationAssign).toHaveBeenCalledTimes(1);
    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringContaining("https://mail.google.com/mail/"),
    );
    expect(result.navigated).toBe(true);
    expect(result.url).toContain("https://mail.google.com/mail/");
  });

  it("correctly encodes Czech diacritics in subject", () => {
    openGmailCompose({
      to: "info@test.cz",
      subject: "Příjemné odpoledne — nabídka",
      body: "Dobrý den,\n\nnabídka.",
    });

    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringContaining("su=P%C5%99%C3%ADjemn%C3%A9+odpoledne+%E2%80%94+nab%C3%ADdka"),
    );
  });

  it("correctly encodes plus address in recipient", () => {
    openGmailCompose({
      to: "user+tag@example.com",
      subject: "Test",
      body: "Body",
    });

    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringContaining("to=user%2Btag%40example.com"),
    );
  });

  it("handles empty subject and body by omitting them", () => {
    openGmailCompose({
      to: "info@test.cz",
      subject: "",
      body: "",
    });

    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/mail\.google\.com\/mail\/\?view=cm&fs=1&to=info%40test\.cz$/),
    );
  });

  it("handles undefined body and subject gracefully", () => {
    openGmailCompose({
      to: "info@test.cz",
      subject: undefined,
      body: undefined,
    });

    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringContaining("to=info%40test.cz"),
    );
    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.not.stringContaining("su="),
    );
    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.not.stringContaining("body="),
    );
  });

  it("preserves newlines in body", () => {
    const body = "Line 1\nLine 2\n\nLine 4";
    openGmailCompose({
      to: "info@test.cz",
      subject: "Test",
      body,
    });

    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringContaining("body=Line+1%0ALine+2%0A%0ALine+4"),
    );
  });

  it("handles ampersand in subject and body", () => {
    openGmailCompose({
      to: "info@test.cz",
      subject: "Test & confirm",
      body: "A & B",
    });

    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringContaining("su=Test+%26+confirm"),
    );
    expect(mockLocationAssign).toHaveBeenCalledWith(
      expect.stringContaining("body=A+%26+B"),
    );
  });

  it("does not use window.open (avoids popup blocking)", () => {
    const mockWindowOpen = vi.fn();
    // @ts-expect-error - add open to window mock
    global.window.open = mockWindowOpen;

    openGmailCompose({
      to: "info@test.cz",
      subject: "Test",
      body: "Body",
    });

    expect(mockWindowOpen).not.toHaveBeenCalled();
    expect(mockLocationAssign).toHaveBeenCalledTimes(1);
  });

  // Regression test — verifies the button handler builds the correct URL from draft data
  it("navigates with full draft data including body", () => {
    openGmailCompose({
      to: "test@example.com",
      subject: "Testovací předmět",
      body: "Ahoj,\n=toto je test.\nMatyáš",
    });

    expect(mockLocationAssign).toHaveBeenCalledTimes(1);
    const calledUrl = mockLocationAssign.mock.calls[0][0];

    // Verify all required parameters are present
    expect(calledUrl).toContain("view=cm");
    expect(calledUrl).toContain("fs=1");
    expect(calledUrl).toContain("to=test%40example.com");
    expect(calledUrl).toContain("su=");
    expect(calledUrl).toContain("body=");

    // Verify round-trip: decode and check exact values
    const url = new URL(calledUrl);
    expect(url.searchParams.get("to")).toBe("test@example.com");
    expect(url.searchParams.get("su")).toBe("Testovací předmět");
    expect(url.searchParams.get("body")).toBe("Ahoj,\n=toto je test.\nMatyáš");
  });
});