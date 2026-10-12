import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openGmailComposeSmart } from "@/lib/outreach/open-gmail-compose";

/**
 * Entry-point contract tests for the draft → Gmail hand-off.
 *
 * Every place an operator can open a stored draft in Gmail must route through
 * the SAME centralized helper (`openGmailComposeSmart`, or `openGmailAppCompose`
 * for the explicit "try the app" retry buttons) and must pass the COMPLETE
 * stored draft — recipient, subject and the full body. The helper opens the
 * iPhone-verified native app deep link on iOS and web compose elsewhere.
 *
 * These tests run in a node environment without a DOM, so — following the
 * pattern already established in gmail-compose-button.test.tsx — the wiring
 * contract is asserted on the component source, and the runtime behavior of
 * the helper (what actually lands in the Gmail compose URL) is exercised
 * directly with a stubbed iPhone browser.
 *
 * Nothing here sends email. Opening a draft is navigation only; the operator
 * presses Send in Gmail, and only "Mark as sent" records a send in PEPA.
 */

function sourceOf(file: string): string {
  return readFileSync(join(__dirname, file), "utf8");
}

interface EntryPoint {
  file: string;
  /** The recipient field the component maps from its stored row. */
  toField: string;
  /** The subject field the component maps from its stored row. */
  subjectField: string;
  /** The body field the component maps from its stored row. */
  bodyField: string;
}

const ENTRY_POINTS: EntryPoint[] = [
  {
    file: "inbox.tsx",
    toField: "to: draft.message.recipient_email",
    subjectField: "subject: draft.message.subject",
    bodyField: "body: draft.message.body",
  },
  {
    file: "drafts-list-client.tsx",
    toField: "to: draft.message.recipient_email",
    subjectField: "subject: draft.message.subject",
    bodyField: "body: draft.message.body",
  },
  {
    file: "draft-detail-client.tsx",
    toField: "to: draft.message.recipient_email",
    subjectField: "subject: draft.message.subject",
    bodyField: "body: draft.message.body",
  },
  {
    file: "follow-ups-client.tsx",
    // The sequence is keyed by lead AND recipient: a follow-up row may target
    // an address other than the lead's primary one, and the compose window
    // must open on the row's own recipient — same rule the notification engine
    // applies ("uses the notified row's own recipient").
    toField: "to: item.message.recipient_email",
    subjectField: "subject: item.message.subject",
    bodyField: "body: item.message.body",
  },
  {
    file: "outreach-history-client.tsx",
    toField: "to: recipient",
    subjectField: "subject,",
    bodyField: "body,",
  },
  {
    file: "follow-up-detail-panel.tsx",
    // The Telegram deep-link landing point — same centralized opener, same
    // row-recipient rule as the workspace.
    toField: "to: detail!.message.recipient_email",
    subjectField: "subject: detail!.message.subject",
    bodyField: "body: detail!.message.body",
  },
];

describe("draft entry points — one centralized, verified opener", () => {
  for (const { file, toField, subjectField, bodyField } of ENTRY_POINTS) {
    it(`${file} opens drafts via openGmailComposeSmart with the full stored draft`, () => {
      const source = sourceOf(file);

      expect(source).toContain("openGmailComposeSmart({");
      expect(source).toContain(toField);
      expect(source).toContain(subjectField);
      expect(source).toContain(bodyField);

      // No self-built Gmail URLs and no ad-hoc navigation — the helper owns
      // the scheme, the encoding and the fallback.
      expect(source).not.toContain("buildGmailAppUrl");
      expect(source).not.toContain("buildGmailComposeUrl");
      expect(source).not.toMatch(/window\.open\(/);
    });

    it(`${file} keeps the Gmail hand-off free of server calls and status writes`, () => {
      const source = sourceOf(file);

      // The open handler must be navigation-only: from its signature to the
      // documented navigation point there is no server action, no await, no
      // status mutation of any kind.
      const start = source.indexOf("function handleOpenInGmail");
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("Navigation happens synchronously", start);
      expect(end).toBeGreaterThan(start);

      // Comments are stripped first so the prose ("nothing is marked sent")
      // cannot mask or trip the code-level scan below.
      const handler = source.slice(start, end).replace(/\/\/[^\n]*/g, "");
      expect(handler).toContain("openGmailComposeSmart");
      expect(handler).not.toMatch(/await\s|markAsSent|recordSent|mark.*[Ss]ent|updateDraft|saveDrafts|deleteOutreach/);
    });
  }
});

describe("manual Gmail-app retry buttons", () => {
  it("inbox routes its retry through openGmailAppCompose with the same full draft", () => {
    const source = sourceOf("inbox.tsx");

    expect(source).toContain("openGmailAppCompose({");
    const retry = source.slice(source.indexOf("function handleTryGmailApp"));
    expect(retry).toContain("to: draft.message.recipient_email");
    expect(retry).toContain("subject: draft.message.subject");
    expect(retry).toContain("body: draft.message.body");
  });

  it("outreach history App button sends the COMPLETE body (it used to send an empty one)", () => {
    const source = sourceOf("outreach-history-client.tsx");

    expect(source).toContain("openGmailAppCompose({");
    expect(source).toContain("body: lead.mainEmail!.message.body");
    // Regression: the old button hard-coded an empty body.
    expect(source).not.toMatch(/body:\s*""/);
  });

  it("gmail-compose-button uses the centralized helpers for both app and web branches", () => {
    const source = sourceOf("gmail-compose-button.tsx");

    expect(source).toContain("openGmailAppCompose(input)");
    expect(source).toContain("openGmailCompose(input)");
    expect(source).not.toContain("buildGmailAppUrl");
  });
});

/**
 * What actually lands in the Gmail compose URL on an iPhone for each entry
 * point's exact field mapping. Uses the real helper with a stubbed browser.
 *
 * The deep link must arrive via the temporary hidden anchor — window.location
 * is never touched, so the Pepa tab keeps its page, scroll position and
 * unsaved state across the round trip to Gmail.
 */
describe("entry-point payloads — what Gmail receives on iPhone", () => {
  const assign = vi.fn();
  let anchors: Array<{ href: string; clicks: number }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    anchors = [];
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    vi.stubGlobal("window", {
      location: { assign, href: "https://pepa.example.com" },
      setTimeout: vi.fn(), // fallback armed but never fired in these tests
    });
    // Page hidden: iOS handed off to the Gmail app.
    vi.stubGlobal("document", {
      hidden: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: () => null,
      createElement: (tag: string) => {
        const el = {
          tag,
          style: {} as Record<string, string>,
          href: "",
          textContent: "",
          id: "",
          rel: "",
          clicks: 0,
          removed: false,
          setAttribute: vi.fn(),
          addEventListener: vi.fn(),
          click() {
            el.clicks += 1;
          },
          remove() {
            el.removed = true;
          },
          appendChild: vi.fn(),
        };
        if (tag === "a") anchors.push(el);
        return el;
      },
      body: { appendChild: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastComposeParams() {
    expect(anchors.length).toBeGreaterThan(0);
    const url = anchors.at(-1)!.href;
    expect(url.startsWith("googlegmail:///co?")).toBe(true);
    // The deep link was clicked…
    expect(anchors.at(-1)!.clicks).toBe(1);
    // …and the Pepa tab itself was never navigated anywhere.
    expect(assign).not.toHaveBeenCalled();
    return { url, params: new URL(url).searchParams };
  }

  it("inbox / drafts list / draft detail payload arrives byte-exact", () => {
    // Same mapping as inbox.tsx, drafts-list-client.tsx, draft-detail-client.tsx:
    // draft.message.{recipient_email, subject, body}
    const draft = {
      recipient_email: "  info@thearchive.cz  ",
      subject: "Nabídka automatizace — příjemné odpoledne",
      body: "Dobrý den,\n\nrád bych vám nabídl řešení & cenové podmínky.\n\nS pozdravem,\nMatyáš",
    };

    openGmailComposeSmart({
      to: draft.recipient_email,
      subject: draft.subject,
      body: draft.body,
    });

    const { params } = lastComposeParams();
    expect(params.get("to")).toBe("info@thearchive.cz");
    expect(params.get("subject")).toBe("Nabídka automatizace — příjemné odpoledne");
    expect(params.get("body")).toBe(
      "Dobrý den,\n\nrád bych vám nabídl řešení & cenové podmínky.\n\nS pozdravem,\nMatyáš",
    );
  });

  it("follow-ups payload (lead.email + message fields) arrives byte-exact", () => {
    // Same mapping as follow-ups-client.tsx: lead.email + message.{subject, body}
    const item = {
      lead: { email: "klient+fakturace@example.com" },
      message: {
        subject: "Re: Nabídka? Ano — č. 1",
        body: "Dobrý den,\n\ndle našeho rozhovoru posílám detaily (100 % & bonus).\n\nMatyáš",
      },
    };

    openGmailComposeSmart({
      to: item.lead.email,
      subject: item.message.subject,
      body: item.message.body,
    });

    const { params } = lastComposeParams();
    expect(params.get("to")).toBe("klient+fakturace@example.com");
    expect(params.get("subject")).toBe("Re: Nabídka? Ano — č. 1");
    expect(params.get("body")).toBe(
      "Dobrý den,\n\ndle našeho rozhovoru posílám detaily (100 % & bonus).\n\nMatyáš",
    );
  });

  it("outreach history payload arrives byte-exact, including the full body", () => {
    // Same mapping as outreach-history-client.tsx: (recipient, subject, body)
    const message = {
      recipient_email: "info@thearchive.cz",
      subject: "Příjemné odpoledne — nabídka",
      body: Array.from(
        { length: 30 },
        (_, i) => `Odstavec ${i + 1}: automatizace recepce šetří čas & nervy personálu.`,
      ).join("\n\n"),
    };

    openGmailComposeSmart({
      to: message.recipient_email,
      subject: message.subject,
      body: message.body,
    });

    const { url, params } = lastComposeParams();
    expect(params.get("body")).toBe(message.body);
    expect(params.get("body")!.length).toBe(message.body.length);
    expect(url.length).toBeGreaterThan(message.body.length); // nothing truncated
  });

  it("a null subject or body still produces a valid, send-free compose URL", () => {
    openGmailComposeSmart({
      to: "info@thearchive.cz",
      subject: null,
      body: null,
    });

    const { url, params } = lastComposeParams();
    expect(params.get("to")).toBe("info@thearchive.cz");
    expect(params.get("subject")).toBe("");
    expect(params.get("body")).toBe("");
    expect(url).not.toMatch(/send|authuser|oauth/i);
  });
});
