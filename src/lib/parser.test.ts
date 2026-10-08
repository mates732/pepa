import { describe, expect, it } from "vitest";

import { isValidEmail, normalizeEmail } from "./email";
import { parseBulkEmails } from "./import/bulk-emails";

describe("normalizeEmail", () => {
  it("trims, lowercases and strips surrounding characters", () => {
    expect(normalizeEmail("  Info@Example.COM ")).toBe("info@example.com");
    expect(normalizeEmail("<info@example.com>")).toBe("info@example.com");
    expect(normalizeEmail('"info@example.com",')).toBe("info@example.com");
    expect(normalizeEmail("(info@example.com);")).toBe("info@example.com");
  });

  it("unwraps display-name form", () => {
    expect(normalizeEmail("Jan Novák <jan.novak@example.cz>")).toBe(
      "jan.novak@example.cz",
    );
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

describe("parseBulkEmails — legacy single-lead paste", () => {
  it("parses the canonical format", () => {
    const { candidates } = parseBulkEmails(
      [
        "recipient: info@example.com",
        "subject: AI recepce pro Example",
        "body: Dobrý den,",
        "",
        "chtěl jsem Vám ukázat...",
      ].join("\n"),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.recipient).toBe("info@example.com");
    expect(candidates[0]!.subject).toBe("AI recepce pro Example");
    expect(candidates[0]!.body).toBe("Dobrý den,\n\nchtěl jsem Vám ukázat...");
    expect(candidates[0]!.status).toBe("parsed");
  });

  it("accepts spacing, casing, full-width colons and markdown bold labels", () => {
    const { candidates } = parseBulkEmails(
      [
        "**Recipient** : <INFO@Example.com>",
        "**Subject**:   Nabídka",
        "**Body**: Ahoj,",
      ].join("\n"),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.recipient).toBe("info@example.com");
    expect(candidates[0]!.subject).toBe("Nabídka");
    expect(candidates[0]!.body).toBe("Ahoj,");
  });

  it("keeps a body label that appears on its own line", () => {
    const { candidates } = parseBulkEmails(
      [
        "recipient: info@example.com",
        "subject: Nabídka",
        "body:",
        "",
        "První odstavec.",
        "",
        "Druhý odstavec.",
      ].join("\n"),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("První odstavec.\n\nDruhý odstavec.");
  });

  it("does not treat a 'To:' line inside the body as a new field", () => {
    const { candidates } = parseBulkEmails(
      [
        "recipient: info@example.com",
        "subject: Nabídka",
        "body:",
        "To: vedení společnosti",
        "Děkuji za čas.",
      ].join("\n"),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("To: vedení společnosti\nDěkuji za čas.");
  });

  it("unquotes single-line subject values", () => {
    const { candidates } = parseBulkEmails(
      [
        "recipient: info@example.com",
        'subject: "Nabídka pro Example"',
        "body: Text",
      ].join("\n"),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.subject).toBe("Nabídka pro Example");
  });

  it("strips markdown fences and blockquote markers", () => {
    const { candidates } = parseBulkEmails(
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
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("Dobrý den,\n|poslední řádek");
  });

  it("reports missing fields", () => {
    const { candidates } = parseBulkEmails("subject: Jen předmět\nbody: Text");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.recipient).toBeNull();
    expect(candidates[0]!.status).toBe("needs_review");
    expect(candidates[0]!.reason).toContain("No recipient address found");
  });

  it("falls back to the untagged text as the body", () => {
    const { candidates } = parseBulkEmails("Dobrý den,\n\nposílám nabídku.");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("Dobrý den,\n\nposílám nabídku.");
    expect(candidates[0]!.reason).toContain("No recipient address found");
  });

  it("uses preamble text as the body when no body label exists", () => {
    const { candidates } = parseBulkEmails(
      "recipient: info@example.com\nsubject: Nabídka\n\nDobrý den,\n\nnabízím spolupráci.",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("Dobrý den,\n\nnabízím spolupráci.");
  });

  it("normalizes windows line endings and trailing whitespace", () => {
    const { candidates } = parseBulkEmails(
      "recipient: info@example.com\r\nsubject: Nabídka\r\nbody:   \r\nAhoj,   \r\n",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("Ahoj,");
  });
});

describe("parseBulkEmails — LEAD block rules", () => {
  it("never returns more candidates than markers", () => {
    const input = `--- LEAD 01 ---
Email: a@example.com
Subject: One

Body one

--- LEAD 02 ---
Email: b@example.com
Subject: Two

Body two`;

    const { candidates } = parseBulkEmails(input);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.recipient)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("keeps differently sized follow-up sets per lead", () => {
    const input = `--- LEAD 01 ---
Email: a@example.com
Subject: One

Body one

Follow-up Subject: Re: One

Follow-up Body:

Body one follow-up.

--- LEAD 02 ---
Email: b@example.com
Subject: Two

Body two`;

    const { candidates } = parseBulkEmails(input);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.followUps).toHaveLength(1);
    expect(candidates[1]!.followUps).toHaveLength(0);
  });

  it("never leaks metadata into the body", () => {
    const input = `--- LEAD 01 ---
Company: S.r.o.
Website: https://example.com
Email: a@example.com
Phone: +420700000001
City: Praha 7
Category: Barbershop
Address: Praha 7

Subject: Nabídka pro Test Barber Praha

Dobrý den,

toto je hlavní email.`;

    const { candidates } = parseBulkEmails(input);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.company).toBe("S.r.o.");
    expect(candidates[0]!.website).toBe("https://example.com");
    expect(candidates[0]!.phone).toBe("+420700000001");
    expect(candidates[0]!.city).toBe("Praha 7");
    expect(candidates[0]!.category).toBe("Barbershop");
    expect(candidates[0]!.address).toBe("Praha 7");
    expect(candidates[0]!.body).not.toContain("Company:");
    expect(candidates[0]!.body).not.toContain("https://example.com");
    expect(candidates[0]!.body).not.toContain("Phone:");
    expect(candidates[0]!.body).not.toContain("Category:");
    expect(candidates[0]!.body).not.toContain("Address:");
  });

  it("never concatenates the recipient, subject or body", () => {
    const input = `--- LEAD 01 ---
Email: a@example.com
Subject: Nabídka pro A

Dobrý den,

text A.

--- LEAD 02 ---
Email: b@example.com
Subject: Nabídka pro B

Dobrý den,

text B.`;

    const { candidates } = parseBulkEmails(input);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.recipient).toBe("a@example.com");
    expect(candidates[1]!.recipient).toBe("b@example.com");
    expect(candidates[0]!.subject).toBe("Nabídka pro A");
    expect(candidates[1]!.subject).toBe("Nabídka pro B");
    expect(candidates[0]!.body).toBe("Dobrý den,\n\ntext A.");
    expect(candidates[1]!.body).toBe("Dobrý den,\n\ntext B.");
    expect(candidates[0]!.body).not.toContain("Nabídka pro B");
    expect(candidates[1]!.body).not.toContain("Nabídka pro A");
  });
});
