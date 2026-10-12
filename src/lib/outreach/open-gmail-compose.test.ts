import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  GMAIL_APP_FALLBACK_DELAY_MS,
  openGmailAppCompose,
  openGmailCompose,
  openGmailComposeSmart,
} from "./open-gmail-compose";

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

/**
 * jsdom-free browser stub: a window whose navigation and timers are recorded
 * instead of performed, plus a document visibility flag.
 */
function stubBrowser({ hidden = false }: { hidden?: boolean } = {}) {
  const assign = vi.fn();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  vi.stubGlobal("window", {
    location: { assign, href: "https://pepa.example.com" },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
    },
  });
  vi.stubGlobal("document", { hidden });
  return { assign, timers };
}

describe("openGmailAppCompose — iPhone-verified native app deep link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates to googlegmail:///co? with the complete draft data", () => {
    const { assign } = stubBrowser();

    const result = openGmailAppCompose({
      to: " info@test.cz ",
      subject: "Příjemné odpoledne — nabídka",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení & více.\n\nS pozdravem, Matyáš",
    });

    expect(assign).toHaveBeenCalledTimes(1);
    const url = assign.mock.calls[0]![0] as string;
    expect(url.startsWith("googlegmail:///co?")).toBe(true);

    const params = new URL(url);
    expect(params.searchParams.get("to")).toBe("info@test.cz");
    expect(params.searchParams.get("subject")).toBe("Příjemné odpoledne — nabídka");
    expect(params.searchParams.get("body")).toBe(
      "Dobrý den,\n\nrád bych vám nabídl řešení & více.\n\nS pozdravem, Matyáš",
    );

    expect(result.navigated).toBe(true);
    expect(result.url).toBe(url);
    expect(result.fallbackUrl).toContain("https://mail.google.com/mail/");
  });

  it("arms a not-installed fallback to web compose after the hand-off window", () => {
    const { assign, timers } = stubBrowser();

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });

    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(GMAIL_APP_FALLBACK_DELAY_MS);

    // The page is still foreground — the app did not open — so the operator
    // is sent to web compose instead of a dead end.
    timers[0]!.fn();
    expect(assign).toHaveBeenCalledTimes(2);
    const fallback = assign.mock.calls[1]![0] as string;
    expect(fallback.startsWith("https://mail.google.com/mail/?view=cm&fs=1")).toBe(true);
    expect(fallback).toContain("to=info%40test.cz");
  });

  it("does not fire the fallback when the app took over (page hidden)", () => {
    const { assign, timers } = stubBrowser({ hidden: true });

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });
    timers[0]!.fn();

    expect(assign).toHaveBeenCalledTimes(1); // only the app deep link
  });

  it("carries a long Czech body un-truncated into the deep link", () => {
    const { assign } = stubBrowser();
    const body = Array.from(
      { length: 25 },
      (_, i) => `Odstavec ${i + 1}: řešení šetří čas vašeho personálu & doporučí.`,
    ).join("\n\n");

    openGmailAppCompose({ to: "info@test.cz", subject: "Dlouhá nabídka", body });

    const url = assign.mock.calls[0]![0] as string;
    expect(new URL(url).searchParams.get("body")).toBe(body);
  });

  it("never sends, never touches the network, never marks anything sent", () => {
    const { assign } = stubBrowser();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const [url] of assign.mock.calls) {
      expect(url as string).not.toMatch(/send|mark|status|authuser|oauth/i);
    }
  });

  it("does not crash during SSR (no window)", () => {
    vi.stubGlobal("window", undefined);

    const result = openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });

    expect(result.url.startsWith("googlegmail:///co?")).toBe(true);
  });
});

describe("openGmailComposeSmart — the one platform-aware entry-point helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubIphone() {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
  }

  it("opens web compose on desktop — unchanged behavior", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    });
    const { assign } = stubBrowser();

    const result = openGmailComposeSmart({
      to: "info@test.cz",
      subject: "Testovací předmět",
      body: "Dobrý den,\n\ntext.",
    });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      expect.stringContaining("https://mail.google.com/mail/?view=cm&fs=1"),
    );
    expect(result.url).toContain("view=cm");
    expect(result.fallbackUrl).toBeUndefined();
  });

  it("opens the verified native app compose on iPhone with the full draft", () => {
    stubIphone();
    const { assign, timers } = stubBrowser();

    const draft = {
      to: "  info@thearchive.cz  ",
      subject: "Nabídka automatizace — příjemné odpoledne",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení & cenové podmínky.\n\nS pozdravem,\nMatyáš",
    };
    const result = openGmailComposeSmart(draft);

    expect(assign).toHaveBeenCalledTimes(1);
    const url = assign.mock.calls[0]![0] as string;
    expect(url.startsWith("googlegmail:///co?")).toBe(true);

    const params = new URL(url);
    expect(params.searchParams.get("to")).toBe("info@thearchive.cz");
    expect(params.searchParams.get("subject")).toBe(draft.subject);
    expect(params.searchParams.get("body")).toBe(draft.body);

    // Web fallback armed in case the app is not installed.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(GMAIL_APP_FALLBACK_DELAY_MS);
    expect(result.fallbackUrl).toContain("view=cm");
  });

  it("routes iPad and iPod through the app path as well", () => {
    for (const userAgent of [
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      "Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    ]) {
      vi.clearAllMocks();
      vi.stubGlobal("navigator", { userAgent });
      const { assign } = stubBrowser();

      openGmailComposeSmart({ to: "info@test.cz", subject: "S", body: "B" });

      expect((assign.mock.calls[0]![0] as string).startsWith("googlegmail:///co?")).toBe(true);
      vi.unstubAllGlobals();
    }
  });

  it("does not crash during SSR (no window, no navigator)", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);

    const result = openGmailComposeSmart({ to: "info@test.cz", subject: "S", body: "B" });

    expect(result.navigated).toBe(true);
    expect(result.url).toContain("mail.google.com");
  });
});