import { describe, expect, it } from "vitest";

import { buildGmailComposeUrl, readComposeParam } from "./gmail-compose";

/**
 * Pure tests for the Gmail compose URL builder.
 *
 * The property that matters is the round trip: whatever PEPA stored as the
 * subject and body must be what Gmail receives after decoding. Encoding bugs are
 * silent and reach the recipient, so each case decodes the URL and compares
 * against the original text rather than asserting on an encoded literal.
 */

describe("buildGmailComposeUrl — shape", () => {
  it("uses the Gmail compose endpoint with the full-screen flag", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz" });

    expect(url.startsWith("https://mail.google.com/mail/?")).toBe(true);
    expect(readComposeParam(url, "view")).toBe("cm");
    expect(readComposeParam(url, "fs")).toBe("1");
  });

  it("adds no tracking or account-state parameters", () => {
    const url = buildGmailComposeUrl({
      to: "info@thearchive.cz",
      subject: "Nabídka",
      body: "Text",
    });

    const keys = [...new URLSearchParams(url.slice(url.indexOf("?") + 1)).keys()];
    expect(keys.sort()).toEqual(["body", "fs", "su", "to", "view"]);
    expect(url).not.toMatch(/authuser|ik|pli|tracking|utm_/i);
  });

  it("omits an absent subject or body instead of sending an empty parameter", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz" });

    expect(readComposeParam(url, "su")).toBeNull();
    expect(readComposeParam(url, "body")).toBeNull();
  });

  it("omits a whitespace-only subject and body", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", subject: "   ", body: "\n\n" });

    expect(readComposeParam(url, "su")).toBeNull();
    expect(readComposeParam(url, "body")).toBeNull();
  });
});

describe("buildGmailComposeUrl — 1. simple recipient", () => {
  it("encodes a plain address", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz" });
    expect(readComposeParam(url, "to")).toBe("info@thearchive.cz");
  });
});

describe("buildGmailComposeUrl — 2. Czech subject", () => {
  it("preserves diacritics through the round trip", () => {
    const subject = "Nabídka automatizace pro váš salon — příjemné odpoledne";
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", subject });

    expect(readComposeParam(url, "su")).toBe(subject);
  });

  it("percent-encodes non-ASCII rather than emitting raw bytes", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", subject: "Příjemné" });

    expect(url).toContain("%C5%99"); // ř
    expect(url).not.toContain("ř");
  });
});

describe("buildGmailComposeUrl — 3. multiline body", () => {
  it("preserves line breaks and paragraph structure", () => {
    const body = "Dobrý den,\n\nrád bych vám nabídl řešení.\n\nS pozdravem";
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", body });

    expect(readComposeParam(url, "body")).toBe(body);
  });

  it("preserves indentation inside a line", () => {
    const body = "Dobrý den,\n  odsazený řádek\n\ttabulátor";
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", body });

    expect(readComposeParam(url, "body")).toBe(body);
  });
});

describe("buildGmailComposeUrl — 4. ampersand and other reserved characters", () => {
  it("keeps an ampersand inside the body from becoming a parameter", () => {
    const body = "Cena 500 Kč & více, pošlete prosím";
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", body });

    // The decoded body must be exact...
    expect(readComposeParam(url, "body")).toBe(body);
    // ...and the raw `&` must have been encoded, so no stray parameter appears.
    expect(url).not.toContain("& více");
    const keys = [...new URLSearchParams(url.slice(url.indexOf("?") + 1)).keys()];
    // Exactly view, fs, to, body — the `&` in the body did not become a parameter.
    expect(keys).toEqual(["view", "fs", "to", "body"]);
  });

  it("handles a question mark, hash and equals sign in the subject", () => {
    const subject = "Cena? ano #1 = 500 Kč";
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", subject });

    expect(readComposeParam(url, "su")).toBe(subject);
  });

  it("handles apostrophes and quotation marks", () => {
    const subject = `Kovářova a "Novákova" — Peter's café`;
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", subject });

    expect(readComposeParam(url, "su")).toBe(subject);
  });
});

describe("buildGmailComposeUrl — 5. plus-addressed email", () => {
  it("preserves the plus sign instead of decoding it as a space", () => {
    const to = "receipt+archive@gmail.com";
    const url = buildGmailComposeUrl({ to });

    // The classic bug: `+` means space in form encoding.
    expect(readComposeParam(url, "to")).toBe(to);
    expect(readComposeParam(url, "to")).not.toContain(" ");
  });

  it("preserves a display-name style value", () => {
    const to = "The Archive <info+archive@thearchive.cz>";
    const url = buildGmailComposeUrl({ to });

    expect(readComposeParam(url, "to")).toBe(to);
  });
});

describe("buildGmailComposeUrl — 6. empty body", () => {
  it("omits an empty string body", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", body: "" });
    expect(readComposeParam(url, "body")).toBeNull();
  });

  it("omits a null body", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", body: null });
    expect(readComposeParam(url, "body")).toBeNull();
  });

  it("still produces a usable URL with no subject or body at all", () => {
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz" });

    expect(readComposeParam(url, "to")).toBe("info@thearchive.cz");
    expect(url.startsWith("https://mail.google.com/mail/?")).toBe(true);
  });
});

describe("buildGmailComposeUrl — 7. long body", () => {
  it("round-trips a long realistic email", () => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `Odstavec ${i + 1}: automatizace recepce šetří čas vašeho personálu.`,
    ).join("\n\n");
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", subject: "Dlouhá nabídka", body });

    expect(readComposeParam(url, "body")).toBe(body);
    expect(readComposeParam(url, "su")).toBe("Dlouhá nabídka");
  });

  it("round-trips a body containing a URL with its own query string", () => {
    const body = "Více na https://pepa.example.com/docs?a=1&b=2 prosím";
    const url = buildGmailComposeUrl({ to: "info@thearchive.cz", body });

    expect(readComposeParam(url, "body")).toBe(body);
  });
});

describe("buildGmailComposeUrl — safety properties", () => {
  it("is a pure function: the same input always yields the same URL", () => {
    const input = { to: "info@thearchive.cz", subject: "Nabídka", body: "Dobrý den,\n\ntext." };
    expect(buildGmailComposeUrl(input)).toBe(buildGmailComposeUrl(input));
  });

  it("does not mutate its input", () => {
    const input = { to: "info@thearchive.cz", subject: " Nabídka ", body: " Text " };
    buildGmailComposeUrl(input);
    expect(input).toEqual({ to: "info@thearchive.cz", subject: " Nabídka ", body: " Text " });
  });

  it("trims surrounding whitespace from the recipient but keeps body content", () => {
    const url = buildGmailComposeUrl({ to: "  info@thearchive.cz  ", body: " Text " });

    expect(readComposeParam(url, "to")).toBe("info@thearchive.cz");
    expect(readComposeParam(url, "body")).toBe(" Text ");
  });

  it("keeps a malicious subject from injecting extra parameters", () => {
    const url = buildGmailComposeUrl({
      to: "info@thearchive.cz",
      subject: "hello&bcc=victim@example.com",
    });

    expect(readComposeParam(url, "bcc")).toBeNull();
    expect(readComposeParam(url, "su")).toBe("hello&bcc=victim@example.com");
  });
});

describe("readComposeParam — edge cases", () => {
  it("returns null for undefined URL", () => {
    expect(readComposeParam(undefined as unknown, "to")).toBeNull();
  });

  it("returns null for null URL", () => {
    expect(readComposeParam(null as unknown, "to")).toBeNull();
  });

  it("returns null for empty string URL", () => {
    expect(readComposeParam("", "to")).toBeNull();
  });

  it("returns null for URL without query string", () => {
    expect(readComposeParam("https://mail.google.com/mail/", "to")).toBeNull();
  });
});

// Regression test — matches the spec in AGENTS.md
describe("buildGmailComposeUrl — regression (fake data from spec)", () => {
  const input = {
    to: "test@example.com",
    subject: "Testovací předmět",
    body: "Ahoj,\n=toto je test.\nMatyáš",
  };

  const url = buildGmailComposeUrl(input);
  const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));

  it("contains view=cm", () => {
    expect(params.get("view")).toBe("cm");
  });

  it("contains fs=1", () => {
    expect(params.get("fs")).toBe("1");
  });

  it("contains the recipient in to", () => {
    expect(params.get("to")).toBe("test@example.com");
  });

  it("contains the subject in su", () => {
    expect(params.get("su")).toBe("Testovací předmět");
  });

  it("contains the body and round-trips the exact content", () => {
    expect(params.get("body")).toBe(input.body);
  });

  it("preserves Czech diacritics in subject", () => {
    expect(decodeURIComponent(params.get("su")!)).toBe("Testovací předmět");
  });

  it("preserves Czech diacritics in body", () => {
    expect(decodeURIComponent(params.get("body")!)).toBe(input.body);
  });
});
