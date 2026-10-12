import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import GmailPage from "./page";
import {
  GMAIL_APP_LINK_CONSTANTS,
  GmailAppLink,
} from "./gmail-app-link";
import { buildGmailAppComposeUrl } from "./gmail-app-compose-url";
import { GMAIL_FALLBACK_BANNER_ID } from "@/lib/outreach/open-gmail-compose";

/**
 * The /gmail page is an isolated app-launching test bench. These tests pin:
 *
 *   1. all three actions use exactly the intended literal URLs (app scheme,
 *      user-verified web URL, standard compose URL) — no helper-built URLs;
 *   2. the app-scheme link keeps its plain anchor behavior and adds only a
 *      MANUAL not-installed fallback to the verified web URL — the page
 *      itself is never navigated or redirected;
 *   3. nothing here sends email or requests mailbox access.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/auth/dal", () => ({
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

async function renderGmailPage() {
  return renderToStaticMarkup(await GmailPage({} as never));
}

function googleHrefList(markup: string) {
  return [...markup.matchAll(/href="([^"]*)"/g)]
    .map((m) => m[1].replaceAll("&amp;", "&"))
    .filter((href) => href.includes("mail.google.com") || href.startsWith("googlegmail:"));
}

describe("/gmail — app-launching test bench", () => {
  it("renders exactly the four intended action URLs, in order", async () => {
    const markup = await renderGmailPage();

    expect(googleHrefList(markup)).toEqual([
      GMAIL_APP_LINK_CONSTANTS.APP_SCHEME,
      "googlegmail:///co?to=test%40example.com&subject=PEPA%20TEST&body=Test%20message",
      "https://mail.google.com/mail/mu/mp/399/#",
      "https://mail.google.com/mail/?view=cm&fs=1&to=test@example.com&su=PEPA%20GMAIL%20TEST&body=Test%20message",
    ]);
  });

  it("labels all four actions", async () => {
    const markup = await renderGmailPage();

    expect(markup).toContain("Otevřít aplikaci Gmail");
    expect(markup).toContain("Otevřít testovací e-mail v aplikaci Gmail");
    expect(markup).toContain("Otevřít Gmail na webu");
    expect(markup).toContain("Otevřít Gmail compose na webu");
  });

  it("explains what each action tests", async () => {
    const markup = await renderGmailPage();

    expect(markup).toContain("Testuje:");
    expect(markup).toContain("googlegmail://");
    expect(markup).toContain("view=cm");
  });

  it("has no sending, OAuth, or mailbox behavior", async () => {
    const markup = await renderGmailPage();

    expect(markup).not.toContain("mailto:");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("accounts.google.com");
    expect(markup).not.toContain("oauth");
  });

  it("keeps the app link a plain anchor with the literal scheme", () => {
    const markup = renderToStaticMarkup(<GmailAppLink />);

    expect(markup).toContain('href="googlegmail://"');
    expect(markup).toContain("Otevřít aplikaci Gmail");
  });
});

describe("buildGmailAppComposeUrl — app compose scheme encoding", () => {
  it("builds the exact test URL from recipient, subject and body", () => {
    expect(
      buildGmailAppComposeUrl({
        to: "test@example.com",
        subject: "PEPA TEST",
        body: "Test message",
      }),
    ).toBe(
      "googlegmail:///co?to=test%40example.com&subject=PEPA%20TEST&body=Test%20message",
    );
  });

  it("preserves Czech diacritics through round-trip decoding", () => {
    const url = buildGmailAppComposeUrl({
      to: "info@test.cz",
      subject: "Příjemné odpoledne — nabídka",
      body: "Dobrý den, zdraví Matyáš.",
    });

    expect(url).toContain("subject=P%C5%99%C3%ADjemn%C3%A9%20odpoledne%20%E2%80%94%20nab%C3%ADdka");
    expect(url).not.toContain("+");
    const params = new URL(url);
    expect(params.searchParams.get("subject")).toBe("Příjemné odpoledne — nabídka");
    expect(params.searchParams.get("body")).toBe("Dobrý den, zdraví Matyáš.");
  });

  it("does not let ampersands or plus signs escape their fields", () => {
    const url = buildGmailAppComposeUrl({
      to: "a+b@example.com",
      subject: "Test & confirm",
      body: "A & B = C",
    });

    const params = new URL(url);
    expect(params.searchParams.get("to")).toBe("a+b@example.com");
    expect(params.searchParams.get("subject")).toBe("Test & confirm");
    expect(params.searchParams.get("body")).toBe("A & B = C");
  });

  it("preserves multiline content and trims the recipient", () => {
    const url = buildGmailAppComposeUrl({
      to: "  info@test.cz  ",
      subject: "Test",
      body: "Řádek 1\n\nŘádek 3 — konec.",
    });

    expect(url).toContain("to=info%40test.cz&");
    const params = new URL(url);
    expect(params.searchParams.get("body")).toBe("Řádek 1\n\nŘádek 3 — konec.");
  });

  it("always emits to, subject and body in that order", () => {
    const url = buildGmailAppComposeUrl({
      to: "x@y.cz",
      subject: "S",
      body: "B",
    });

    expect(url).toBe("googlegmail:///co?to=x%40y.cz&subject=S&body=B");
  });
});

describe("GmailAppLink — manual not-installed fallback", () => {
  interface FakeLink {
    tag: string;
    id: string;
    href: string;
    textContent: string;
    children: FakeLink[];
    style: Record<string, string>;
    setAttribute: () => void;
    addEventListener: () => void;
    remove: () => void;
    appendChild(child: FakeLink): FakeLink;
  }

  function setup({ hidden = false }: { hidden?: boolean } = {}) {
    const assign = vi.fn();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const created: FakeLink[] = [];
    const docListeners = new Map<string, () => void>();

    const make = (tag: string): FakeLink => {
      const el: FakeLink = {
        tag,
        id: "",
        href: "",
        textContent: "",
        children: [],
        style: {},
        setAttribute: () => {},
        addEventListener: () => {},
        remove: () => {},
        appendChild(child) {
          el.children.push(child);
          return child;
        },
      };
      created.push(el);
      return el;
    };

    const documentStub = {
      hidden,
      addEventListener: (type: string, fn: () => void) => {
        docListeners.set(type, fn);
      },
      removeEventListener: (type: string) => {
        docListeners.delete(type);
      },
      getElementById: (id: string) => created.find((el) => el.id === id) ?? null,
      createElement: make,
      body: { appendChild: vi.fn() },
    };

    vi.stubGlobal("window", {
      location: { assign },
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
      },
    });
    vi.stubGlobal("document", documentStub);

    return { assign, timers, created, docListeners, documentStub };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bannerOf(created: FakeLink[]) {
    return created.find((el) => el.tag === "div" && el.id === GMAIL_FALLBACK_BANNER_ID);
  }

  it("offers the verified web URL as a MANUAL banner instead of navigating the page", () => {
    const { assign, timers, created } = setup();

    // jsdom-free: invoke the click handler directly on the rendered element.
    const link = GmailAppLink();
    (link.props.onClick as () => void)();

    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(GMAIL_APP_LINK_CONSTANTS.FALLBACK_DELAY_MS);
    expect(bannerOf(created)).toBeUndefined();

    // Never backgrounded → the app did not open → the banner appears…
    timers[0]!.fn();

    // …and the page is NEVER navigated automatically: the verified web URL
    // is only offered, following it is an explicit operator click.
    expect(assign).not.toHaveBeenCalled();
    const banner = bannerOf(created)!;
    expect(banner).toBeDefined();
    const webLink = banner.children
      .flatMap((c) => c.children)
      .find((c) => c.tag === "a");
    expect(webLink?.href).toBe(GMAIL_APP_LINK_CONSTANTS.FALLBACK_WEB_URL);
  });

  it("never replaces the page after the app took over (background latch)", () => {
    const { assign, timers, created, docListeners, documentStub } = setup();

    const link = GmailAppLink();
    (link.props.onClick as () => void)();

    // iOS hands off to Gmail: the page goes to background…
    documentStub.hidden = true;
    docListeners.get("visibilitychange")!();

    // …and when the operator returns, the suspended timer resumes. It must
    // do nothing: no banner, and above all no navigation to mail.google.com.
    documentStub.hidden = false;
    timers[0]!.fn();

    expect(assign).not.toHaveBeenCalled();
    expect(bannerOf(created)).toBeUndefined();
  });
});
