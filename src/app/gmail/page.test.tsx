import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import GmailPage from "./page";
import {
  GMAIL_APP_LINK_CONSTANTS,
  GmailAppLink,
} from "./gmail-app-link";

/**
 * The /gmail page is an isolated app-launching test bench. These tests pin:
 *
 *   1. all three actions use exactly the intended literal URLs (app scheme,
 *      user-verified web URL, standard compose URL) — no helper-built URLs;
 *   2. the app-scheme link keeps its plain anchor behavior and adds only a
 *      not-installed fallback to the verified web URL;
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
  it("renders exactly the three intended action URLs, in order", async () => {
    const markup = await renderGmailPage();

    expect(googleHrefList(markup)).toEqual([
      GMAIL_APP_LINK_CONSTANTS.APP_SCHEME,
      "https://mail.google.com/mail/mu/mp/399/#",
      "https://mail.google.com/mail/?view=cm&fs=1&to=test@example.com&su=PEPA%20GMAIL%20TEST&body=Test%20message",
    ]);
  });

  it("labels all three actions", async () => {
    const markup = await renderGmailPage();

    expect(markup).toContain("Otevřít aplikaci Gmail");
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

describe("GmailAppLink — not-installed fallback", () => {
  function setup({ hidden }: { hidden: boolean }) {
    const assign = vi.fn();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    vi.stubGlobal("window", {
      location: { assign },
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
      },
    });
    vi.stubGlobal("document", { hidden });
    return { assign, timers };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the verified web URL when the app did not open", () => {
    const { assign, timers } = setup({ hidden: false });

    // jsdom-free: invoke the click handler directly on the rendered element.
    const link = GmailAppLink();
    (link.props.onClick as () => void)();

    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(GMAIL_APP_LINK_CONSTANTS.FALLBACK_DELAY_MS);
    timers[0]!.fn();
    expect(assign).toHaveBeenCalledWith(GMAIL_APP_LINK_CONSTANTS.FALLBACK_WEB_URL);
  });

  it("does not navigate away when the app took over (page hidden)", () => {
    const { assign, timers } = setup({ hidden: true });

    const link = GmailAppLink();
    (link.props.onClick as () => void)();
    timers[0]!.fn();

    expect(assign).not.toHaveBeenCalled();
  });
});
