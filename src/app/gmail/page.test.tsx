import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import GmailPage from "./page";

/**
 * The /gmail page is an isolated baseline whose only job is to navigate to
 * Gmail compose via two plain static anchors. These tests pin exactly that:
 *
 *   1. both hrefs are the literal intended URLs (fake data only for the
 *      diagnostic link) — built by the browser, not by any Pepa helper;
 *   2. the page is a server component with no client-side behavior: no
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
  it("renders the primary link with the exact bare compose URL", async () => {
    const markup = await renderGmailPage();

    expect(markup).toContain(
      'href="https://mail.google.com/mail/?view=cm&amp;fs=1"',
    );
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
