import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import GmailPage from "./page";

/**
 * The /gmail page is an isolated baseline whose only job is to navigate to
 * Gmail via two plain static anchors. These tests pin exactly that:
 *
 *   1. the primary href is the exact user-verified iPhone URL that opens
 *      Gmail directly — no added parameters, no helper-built URL;
 *   2. the diagnostic href is the literal bare compose URL with fake data;
 *   3. the page is a server component with no client-side behavior: no
 *      onClick, no window.open, no server action form.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/auth/dal", () => ({
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

async function renderGmailPage() {
  return renderToStaticMarkup(await GmailPage({} as never));
}

describe("/gmail — isolated Gmail compose baseline", () => {
  it("renders the primary link with the exact user-verified iPhone URL", async () => {
    const markup = await renderGmailPage();

    const hrefs = [...markup.matchAll(/href="(https:\/\/mail\.google\.com[^"]*)"/g)]
      .map((m) => m[1].replaceAll("&amp;", "&"));

    // The verified URL appears verbatim, exactly once, with no added
    // parameters — and it is the first (primary) link on the page.
    expect(hrefs).toEqual([
      "https://mail.google.com/mail/mu/mp/399/#",
      "https://mail.google.com/mail/?view=cm&fs=1&to=test@example.com&su=PEPA%20GMAIL%20TEST&body=Test%20message",
    ]);
  });

  it("renders the diagnostic link with the exact fake-data URL", async () => {
    const markup = await renderGmailPage();

    expect(markup).toContain(
      'href="https://mail.google.com/mail/?view=cm&amp;fs=1&amp;to=test@example.com&amp;su=PEPA%20GMAIL%20TEST&amp;body=Test%20message"',
    );
    expect(markup).toContain("Testovací e-mail");
  });

  it("has no client-side behavior", async () => {
    const markup = await renderGmailPage();

    expect(markup).not.toContain("onClick");
    expect(markup).not.toContain("window.open");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("mailto:");
    expect(markup).not.toContain("googlegmail://");
  });

  it("shows the heading and explanation", async () => {
    const markup = await renderGmailPage();

    expect(markup).toContain("Gmail");
    expect(markup).toContain("Otevřít Gmail");
  });
});
