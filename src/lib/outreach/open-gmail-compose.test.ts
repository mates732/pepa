import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  GMAIL_APP_FALLBACK_DELAY_MS,
  GMAIL_FALLBACK_BANNER_ID,
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
 * jsdom-free browser stub: window navigation/timers are recorded instead of
 * performed, and the document gets a minimal DOM (createElement / body /
 * visibility listeners) so the deep-link anchor and the manual fallback
 * banner can be inspected.
 */
interface FakeElement {
  tag: string;
  style: Record<string, string>;
  children: FakeElement[];
  href: string;
  textContent: string;
  id: string;
  type: string;
  rel: string;
  attrs: Record<string, string>;
  clicks: number;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
  remove(): void;
  appendChild(child: FakeElement): FakeElement;
}

function fakeElement(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    style: {},
    children: [],
    href: "",
    textContent: "",
    id: "",
    type: "",
    rel: "",
    attrs: {},
    clicks: 0,
    removed: false,
    setAttribute(name, value) {
      el.attrs[name] = value;
    },
    addEventListener() {},
    click() {
      el.clicks += 1;
    },
    remove() {
      el.removed = true;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
  };
  return el;
}

function stubBrowser({ hidden = false }: { hidden?: boolean } = {}) {
  const assign = vi.fn();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const created: FakeElement[] = [];
  const docListeners = new Map<string, () => void>();
  const body = { appendChild: vi.fn((el: FakeElement) => el) };

  const documentStub = {
    hidden,
    body,
    addEventListener: (type: string, fn: () => void) => {
      docListeners.set(type, fn);
    },
    removeEventListener: (type: string) => {
      docListeners.delete(type);
    },
    getElementById: (id: string) => created.find((el) => el.id === id) ?? null,
    createElement: (tag: string) => {
      const el = fakeElement(tag);
      created.push(el);
      return el;
    },
  };

  vi.stubGlobal("window", {
    location: { assign, href: "https://pepa.example.com" },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
    },
  });
  vi.stubGlobal("document", documentStub);

  return { assign, timers, created, docListeners, body, documentStub };
}

/** The temporary hidden anchor carrying the app deep link. */
function deepLinkAnchor(created: FakeElement[]): FakeElement {
  const anchor = created.find((el) => el.tag === "a" && el.href.startsWith("googlegmail:"));
  if (!anchor) throw new Error("no googlegmail deep-link anchor was created");
  return anchor;
}

/** The manual fallback banner (the div carrying the banner id). */
function fallbackBanner(created: FakeElement[]): FakeElement | undefined {
  return created.find((el) => el.tag === "div" && el.id === GMAIL_FALLBACK_BANNER_ID);
}

describe("openGmailAppCompose — native app deep link without touching the Pepa tab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires the verified googlegmail:///co? deep link directly from a hidden anchor", () => {
    const { created, body } = stubBrowser();

    const result = openGmailAppCompose({
      to: " info@test.cz ",
      subject: "Příjemné odpoledne — nabídka",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení & více.\n\nS pozdravem, Matyáš",
    });

    const anchor = deepLinkAnchor(created);
    expect(anchor.href.startsWith("googlegmail:///co?")).toBe(true);
    expect(anchor.clicks).toBe(1);
    expect(anchor.removed).toBe(true);
    expect(body.appendChild).toHaveBeenCalledWith(anchor);

    const params = new URL(anchor.href);
    expect(params.searchParams.get("to")).toBe("info@test.cz");
    expect(params.searchParams.get("subject")).toBe("Příjemné odpoledne — nabídka");
    expect(params.searchParams.get("body")).toBe(
      "Dobrý den,\n\nrád bych vám nabídl řešení & více.\n\nS pozdravem, Matyáš",
    );

    expect(result.navigated).toBe(true);
    expect(result.url).toBe(anchor.href);
    expect(result.fallbackUrl).toContain("https://mail.google.com/mail/");
  });

  it("sends spaces as %20 to the anchor — the app never receives form-style `+`", () => {
    // Regression: the native app printed `Dobrý+den,` because the deep link
    // carried application/x-www-form-urlencoded spaces. The anchor href must
    // contain NO raw `+` at all; genuine plus signs arrive as %2B.
    const { created } = stubBrowser();

    const body = "Dobrý den,\n\nkrátce navazuji na svůj e-mail. Cena 100 + DPH & doprava";
    openGmailAppCompose({ to: "info@test.cz", subject: "Dobrý den, nabídka", body });

    const href = deepLinkAnchor(created).href;
    expect(href).toContain("Dobr%C3%BD%20den%2C");
    expect(href).not.toContain("+");
    expect(new URL(href).searchParams.get("body")).toBe(body);
    expect(new URL(href).searchParams.get("subject")).toBe("Dobrý den, nabídka");
  });

  it("NEVER navigates the Pepa tab: window.location is not touched at all", () => {
    const { assign } = stubBrowser();

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });

    expect(assign).not.toHaveBeenCalled();
  });

  it("offers the web fallback as a MANUAL banner, never an automatic redirect", () => {
    const { assign, timers, created } = stubBrowser();

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });

    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(GMAIL_APP_FALLBACK_DELAY_MS);
    expect(fallbackBanner(created)).toBeUndefined(); // nothing appears right away

    // Never backgrounded → the app did not open → the banner appears…
    timers[0]!.fn();

    // …and even then nothing navigates: the web URL is only an offer the
    // operator can follow with an explicit click.
    expect(assign).not.toHaveBeenCalled();
    const banner = fallbackBanner(created);
    expect(banner).toBeDefined();
    const webLink = banner!.children.flatMap((c) => c.children).find((c) => c.tag === "a");
    expect(webLink).toBeDefined();
    expect(webLink!.href.startsWith("https://mail.google.com/mail/?view=cm&fs=1")).toBe(true);
    expect(webLink!.href).toContain("to=info%40test.cz");
    expect(webLink!.textContent).toBe("Otevřít Gmail na webu");
  });

  it("suppresses the fallback permanently once the page was backgrounded (return from Gmail)", () => {
    // Regression for the reported bug: iOS SUSPENDS timers while the page is
    // backgrounded, so a naive fallback timer runs when the operator RETURNS
    // from Gmail — document.hidden is false again by then — and the old
    // version assigned mail.google.com web compose into the Pepa tab at that
    // exact moment. The background latch must kill the fallback for good.
    const { assign, timers, created, docListeners, documentStub } = stubBrowser();

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });

    // iOS hands off to Gmail: the page goes to background…
    documentStub.hidden = true;
    docListeners.get("visibilitychange")!();

    // …and the operator later returns to Safari; the suspended timer resumes.
    documentStub.hidden = false;
    timers[0]!.fn();

    expect(assign).not.toHaveBeenCalled();
    expect(fallbackBanner(created)).toBeUndefined();
  });

  it("settles the visibility listener once the attempt is over", () => {
    const { timers, docListeners } = stubBrowser();

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });
    expect(docListeners.has("visibilitychange")).toBe(true);

    timers[0]!.fn();
    expect(docListeners.has("visibilitychange")).toBe(false);
  });

  it("carries a long Czech body un-truncated into the deep link", () => {
    const { created } = stubBrowser();
    const body = Array.from(
      { length: 25 },
      (_, i) => `Odstavec ${i + 1}: řešení šetří čas vašeho personálu & doporučí.`,
    ).join("\n\n");

    openGmailAppCompose({ to: "info@test.cz", subject: "Dlouhá nabídka", body });

    const anchor = deepLinkAnchor(created);
    expect(new URL(anchor.href).searchParams.get("body")).toBe(body);
  });

  it("never sends, never touches the network, never marks anything sent", () => {
    const { created } = stubBrowser();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    openGmailAppCompose({ to: "info@test.cz", subject: "Test", body: "Body" });

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const el of created) {
      expect(el.href).not.toMatch(/send|mark|status|authuser|oauth/i);
    }
  });

  it("does not crash during SSR (no window, no document)", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);

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

  it("opens the verified native app compose on iPhone with the full draft — without navigating the tab", () => {
    stubIphone();
    const { assign, timers, created } = stubBrowser();

    const draft = {
      to: "  info@thearchive.cz  ",
      subject: "Nabídka automatizace — příjemné odpoledne",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení & cenové podmínky.\n\nS pozdravem,\nMatyáš",
    };
    const result = openGmailComposeSmart(draft);

    const anchor = deepLinkAnchor(created);
    expect(anchor.href.startsWith("googlegmail:///co?")).toBe(true);
    expect(assign).not.toHaveBeenCalled(); // the Pepa tab stays put

    const params = new URL(anchor.href);
    expect(params.searchParams.get("to")).toBe("info@thearchive.cz");
    expect(params.searchParams.get("subject")).toBe(draft.subject);
    expect(params.searchParams.get("body")).toBe(draft.body);

    // Manual web fallback armed in case the app is not installed.
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
      const { assign, created } = stubBrowser();

      openGmailComposeSmart({ to: "info@test.cz", subject: "S", body: "B" });

      expect(deepLinkAnchor(created).href.startsWith("googlegmail:///co?")).toBe(true);
      expect(assign).not.toHaveBeenCalled();
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