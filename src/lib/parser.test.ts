import { describe, expect, it } from "vitest";

import { isValidEmail, normalizeEmail } from "./email";
import { parseOutreachInput } from "./parser";

describe("normalizeEmail", () => {
  it("trims, lowercases and strips surrounding characters", () => {
    expect(normalizeEmail("  Info@Example.COM ")).toBe("info@example.com");
    expect(normalizeEmail("<info@example.com>")).toBe("info@example.com");
    expect(normalizeEmail('"info@example.com",')).toBe("info@example.com");
    expect(normalizeEmail("(info@example.com);")).toBe("info@example.com");
  });

  it("unwraps display-name form", () => {
    expect(normalizeEmail("Jan Novák <jan.novak@example.cz>")).toBe("jan.novak@example.cz");
  });

  it("keeps dots, dashes, plus and percent inside the address", () => {
    expect(normalizeEmail("first.last+tag%20-x@sub.example.co.uk")).toBe(
      "first.last+tag%20-x@sub.example.co.uk",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeEmail("")).toBe("");
    expect(normalizeEmail(null)).toBe("");
  });

  it("validates shape after normalization", () => {
    expect(isValidEmail(" INFO@Example.com ")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
});

describe("parseOutreachInput", () => {
  it("parses the canonical format", () => {
    const parsed = parseOutreachInput(
      [
        "recipient: info@example.com",
        "subject: AI recepce pro Example",
        "body: Dobrý den,",
        "",
        "chtěl jsem Vám ukázat...",
      ].join("\n"),
    );

    expect(parsed.recipient).toBe("info@example.com");
    expect(parsed.subject).toBe("AI recepce pro Example");
    expect(parsed.body).toBe("Dobrý den,\n\nchtěl jsem Vám ukázat...");
    expect(parsed.missing).toEqual([]);
  });

  it("accepts spacing, casing, full-width colons and markdown bold labels", () => {
    const parsed = parseOutreachInput(
      [
        "**Recipient** : <INFO@Example.com>",
        "**Subject**:   Nabídka",
        "**Body**: Ahoj,",
      ].join("\n"),
    );

    expect(parsed.recipient).toBe("info@example.com");
    expect(parsed.subject).toBe("Nabídka");
    expect(parsed.body).toBe("Ahoj,");
  });

  it("keeps a body label that appears on its own line", () => {
    const parsed = parseOutreachInput(
      ["recipient: info@example.com", "subject: Nabídka", "body:", "", "První odstavec.", "", "Druhý odstavec."].join("\n"),
    );

    expect(parsed.body).toBe("První odstavec.\n\nDruhý odstavec.");
  });

  it("does not treat a 'To:' line inside the body as a new field", () => {
    const parsed = parseOutreachInput(
      [
        "recipient: info@example.com",
        "subject: Nabídka",
        "body:",
        "To: vedení společnosti",
        "Děkuji za čas.",
      ].join("\n"),
    );

    expect(parsed.body).toBe("To: vedení společnosti\nDěkuji za čas.");
  });

  it("unquotes single-line subject values", () => {
    const parsed = parseOutreachInput(
      ['recipient: info@example.com', 'subject: "Nabídka pro Example"', "body: Text"].join("\n"),
    );
    expect(parsed.subject).toBe("Nabídka pro Example");
  });

  it("strips markdown fences and blockquote markers", () => {
    const parsed = parseOutreachInput(
      [
        "```",
        "recipient: info@example.com",
        "subject: Nabídka",
        "body:",
        "> Dobrý den,",
        ">|poslední řádek",
        "```",
      ].join("\n"),
    );
    expect(parsed.body).toBe("Dobrý den,\n|poslední řádek");
  });

  it("reports missing fields", () => {
    const parsed = parseOutreachInput("subject: Jen předmět\nbody: Text");
    expect(parsed.missing).toEqual(["recipient"]);
  });

  it("falls back to the untagged text as the body", () => {
    const parsed = parseOutreachInput("Dobrý den,\n\nposílám nabídku.");
    expect(parsed.body).toBe("Dobrý den,\n\nposílám nabídku.");
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("uses preamble text as the body when no body label exists", () => {
    const parsed = parseOutreachInput(
      "recipient: info@example.com\nsubject: Nabídka\n\nDobrý den,\n\nnabízím spolupráci.",
    );
    expect(parsed.body).toBe("Dobrý den,\n\nnabízím spolupráci.");
  });

  it("normalizes windows line endings and trailing whitespace", () => {
    const parsed = parseOutreachInput(
      "recipient: info@example.com\r\nsubject: Nabídka\r\nbody:   \r\nAhoj,   \r\n",
    );
    expect(parsed.body).toBe("Ahoj,");
  });
});