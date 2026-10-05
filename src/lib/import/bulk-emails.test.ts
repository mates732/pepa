import { describe, expect, it } from "vitest";

import { MAX_BULK_EMAILS, parseBulkEmails } from "./bulk-emails";

/**
 * The bulk email splitter.
 *
 * The contract under test is narrow and strict: the operator's finished emails
 * come out the other side with the same recipient, subject and body, one block
 * each. Nothing here may rewrite, shorten, reorder or invent text — a test that
 * did not assert exact preservation would happily pass against a "helpful"
 * summariser, which is the failure mode this feature exists to rule out.
 */

/** Format A — headers, `---` between each email. */
const FORMAT_A = `To: info@bella.cz
Subject: Váš web
Dobrý den,

rád bych vám ukázal web pro vaši společnost.

S pozdravem
Petr

---
To: barber@barberx.cz
Subject: AI recepce
Dobrý den,

nabízím AI recepci pro vaši provozovnu.

S pozdravem
Petr`;

/** Format B — no headers, just a gap between finished emails. */
const FORMAT_B = `Dobrý den,

rád bych vám ukázal web pro vaši společnost.

S pozdravem
Petr


Dobrý den,

nabízím AI recepci pro vaši provozovnu.

S pozdravem
Petr`;

/** Format C — a copied mail-client block. */
const FORMAT_C = `From: Petr <petr@firma.cz>
Date: Tue, 1 Oct 2026 at 09:12:00 +0200
To: info@bella.cz
Subject: Váš web

Dobrý den,

rád bych vám ukázal web.

> Dříve jste psal/a: ahoj, máme zájem.

S pozdravem`;

function twentyEmails(): string {
  return Array.from(
    { length: 20 },
    (_, i) =>
      `To: info@firma${i + 1}.cz\nSubject: Nabídka ${i + 1}\nDobrý den,\n\ntext firmy ${i + 1}.\n\nS pozdravem`,
  ).join("\n\n---\n\n");
}

describe("parseBulkEmails — TEST 1: twenty finished emails", () => {
  it("produces twenty emails", () => {
    const { candidates } = parseBulkEmails(twentyEmails());

    expect(candidates).toHaveLength(20);
    expect(candidates.every((c) => c.status === "parsed")).toBe(true);
    expect(candidates.map((c) => c.recipient)).toEqual(
      Array.from({ length: 20 }, (_, i) => `info@firma${i + 1}.cz`),
    );
  });

  it("keeps each email's own subject — no two share one", () => {
    const { candidates } = parseBulkEmails(twentyEmails());

    expect(new Set(candidates.map((c) => c.subject)).size).toBe(20);
    expect(candidates[7]!.subject).toBe("Nabídka 8");
    expect(candidates[7]!.body).toContain("text firmy 8");
    expect(candidates[7]!.body).not.toContain("firmy 9");
  });

  it("assigns a stable index to each email", () => {
    const { candidates } = parseBulkEmails(twentyEmails());

    expect(candidates.map((c) => c.index)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
});

describe("parseBulkEmails — TEST 2 and 3: recipient and subject extraction", () => {
  it("reads the recipient from Format A", () => {
    const { candidates } = parseBulkEmails(FORMAT_A);

    expect(candidates[0]!.recipient).toBe("info@bella.cz");
    expect(candidates[1]!.recipient).toBe("barber@barberx.cz");
  });

  it("reads the subject from Format A", () => {
    const { candidates } = parseBulkEmails(FORMAT_A);

    expect(candidates[0]!.subject).toBe("Váš web");
    expect(candidates[1]!.subject).toBe("AI recepce");
  });

  it("unwraps a display name and normalizes the address", () => {
    const { candidates } = parseBulkEmails(
      "To: Kadeřnictví Bella <INFO@Bella.CZ>\nSubject: Web\nDobrý den",
    );

    expect(candidates[0]!.recipient).toBe("info@bella.cz");
  });

  it("accepts a recipient wrapped onto the line below the label", () => {
    const { candidates } = parseBulkEmails("To:\ninfo@bella.cz\nSubject: Web\nDobrý den");

    expect(candidates[0]!.recipient).toBe("info@bella.cz");
  });

  it("reads Czech and English label aliases alike", () => {
    const { candidates } = parseBulkEmails(
      "Adresát: info@bella.cz\nPředmět: Web\nDobrý den\n\n---\nE-mail: info@barber.cz\nNadpis: AI recepce\nDobrý den",
    );

    expect(candidates[0]!.recipient).toBe("info@bella.cz");
    expect(candidates[0]!.subject).toBe("Web");
    expect(candidates[1]!.recipient).toBe("info@barber.cz");
    expect(candidates[1]!.subject).toBe("AI recepce");
  });

  it("warns rather than inventing a subject", () => {
    const { candidates } = parseBulkEmails("To: info@bella.cz\nDobrý den, text");

    expect(candidates[0]!.subject).toBeNull();
    expect(candidates[0]!.warnings.join(" ")).toContain("No subject");
  });
});

describe("parseBulkEmails — TEST 4 and 10: body extraction and exact preservation", () => {
  it("keeps the body exactly as pasted", () => {
    const { candidates } = parseBulkEmails(FORMAT_A);

    expect(candidates[0]!.body).toBe(
      "Dobrý den,\n\nrád bych vám ukázal web pro vaši společnost.\n\nS pozdravem\nPetr",
    );
  });

  it("does not fold a horizontal rule out of Format A — it is the separator", () => {
    const { candidates } = parseBulkEmails(FORMAT_A);

    expect(candidates[0]!.body).not.toContain("---");
    expect(candidates[1]!.body).not.toContain("---");
  });

  it("keeps a horizontal rule that is INSIDE a body", () => {
    // The important negative case: `---` only separates when there are no
    // recipient headers to go on.
    const { candidates } = parseBulkEmails(
      "To: info@bella.cz\nSubject: Nabídka\nDobrý den,\n\n---\n\nS pozdravem",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("Dobrý den,\n\n---\n\nS pozdravem");
  });

  it("keeps a sentence that merely contains dashes intact", () => {
    const { candidates } = parseBulkEmails(
      "To: info@bella.cz\nSubject: Nabídka\nRozsah: 5 - 10 dní, ozveme se.",
    );

    expect(candidates[0]!.body).toBe("Rozsah: 5 - 10 dní, ozveme se.");
  });

  it("drops copied mail headers and one level of reply quoting", () => {
    const { candidates } = parseBulkEmails(FORMAT_C);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.recipient).toBe("info@bella.cz");
    expect(candidates[0]!.subject).toBe("Váš web");
    expect(candidates[0]!.body).toContain("S pozdravem");
    // The original sender must never be mistaken for the recipient.
    expect(candidates[0]!.body).not.toContain("petr@firma.cz");
    expect(candidates[0]!.body).not.toContain("Date:");
  });

  it("keeps a headerless body rather than losing the greeting", () => {
    const { candidates } = parseBulkEmails(
      `info@bella.cz\nVáš web\nDobrý den,\n\ntext\n\n---\n\nbarber@barberx.cz\nAI recepce\nDobrý den,\n\ntext2`,
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.recipient).toBe("info@bella.cz");
    expect(candidates[1]!.recipient).toBe("barber@barberx.cz");
    // The greeting survives. The recipient does not become the first line of the
    // body.
    expect(candidates[0]!.body).toContain("Dobrý den,");
    expect(candidates[0]!.body).not.toContain("info@bella.cz");
  });

  it("does not invent a subject out of a headerless block", () => {
    // With no `Subject:` label there is nothing to say which line is the subject
    // and which is the greeting. Guessing would be inventing structure the
    // operator did not write, so the block is reported without one and the
    // operator is told why.
    const { candidates } = parseBulkEmails(
      "info@bella.cz\nVáš web\nDobrý den,\n\ntext",
    );

    expect(candidates[0]!.status).toBe("parsed");
    expect(candidates[0]!.subject).toBeNull();
    expect(candidates[0]!.warnings.join(" ")).toContain("No subject");
    expect(candidates[0]!.body).toContain("Váš web");
  });

  it("only tidies whitespace — never a word", () => {
    const { candidates } = parseBulkEmails(
      "To: info@bella.cz\nSubject:   Nabídka   \nDobrý den,   \n\n\n\ntext s   koncovou mezerou   ",
    );

    expect(candidates[0]!.subject).toBe("Nabídka");
    expect(candidates[0]!.body).toBe("Dobrý den,\n\ntext s   koncovou mezerou");
  });
});

describe("parseBulkEmails — splitting strategies", () => {
  it("prefers recipient headers over separators", () => {
    const result = parseBulkEmails(FORMAT_A);
    expect(result.splitBy).toBe("recipient_header");
  });

  it("falls back to a separator when there are no headers", () => {
    const result = parseBulkEmails(
      `info@bella.cz\nVáš web\nDobrý den\n\n---\n\nbarber@barberx.cz\nAI recepce\nDobrý den`,
    );
    expect(result.splitBy).toBe("separator");
    expect(result.candidates).toHaveLength(2);
  });

  it("falls back to a blank gap when there is neither a header nor a rule", () => {
    const result = parseBulkEmails(FORMAT_B);
    expect(result.splitBy).toBe("blank_line");
    // Neither block names a recipient, so neither is sendable — but the
    // operator sees both rather than one merged blob.
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.every((c) => c.status === "needs_review")).toBe(true);
  });

  it("reads one email pasted alone", () => {
    const { candidates } = parseBulkEmails("To: info@bella.cz\nSubject: Web\nDobrý den, text");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe("parsed");
  });

  it("returns nothing for an empty paste", () => {
    expect(parseBulkEmails("").candidates).toEqual([]);
    expect(parseBulkEmails("   \n\n ").candidates).toEqual([]);
  });
});

describe("parseBulkEmails — TEST 8: duplicates inside one paste", () => {
  it("collapses the same recipient however it is capitalised", () => {
    const { candidates } = parseBulkEmails(
      `To: info@bella.cz\nSubject: První\ntext\n\n---\n\nTo: INFO@BELLA.CZ\nSubject: Druhá\ntext\n\n---\n\nTo: barber@barberx.cz\nSubject: Třetí\ntext`,
    );

    expect(candidates).toHaveLength(3);
    expect(candidates[0]!.status).toBe("parsed");
    expect(candidates[1]!.status).toBe("duplicate");
    expect(candidates[1]!.duplicateOf).toBe(1);
    expect(candidates[1]!.reason).toContain("email 1");
    expect(candidates[2]!.status).toBe("parsed");
  });

  it("does not treat two addresses at one company as duplicates", () => {
    const { candidates } = parseBulkEmails(
      "To: info@bella.cz\nSubject: A\ntext\n\n---\n\nTo: objednavky@bella.cz\nSubject: B\ntext",
    );

    expect(candidates.every((c) => c.status === "parsed")).toBe(true);
  });

  it("keeps the duplicate's own subject and body so the operator can compare", () => {
    const { candidates } = parseBulkEmails(
      "To: info@bella.cz\nSubject: První verze\ntext\n\n---\n\nTo: info@bella.cz\nSubject: Druhá verze\njiný text",
    );

    expect(candidates[1]!.subject).toBe("Druhá verze");
    expect(candidates[1]!.body).toBe("jiný text");
  });

  it("never marks an unreadable block as somebody else's duplicate", () => {
    const { candidates } = parseBulkEmails("To: info@bella.cz\nSubject: A\ntext\n\n---\n\nSubject: B\ntext");

    expect(candidates[1]!.status).toBe("needs_review");
    expect(candidates[1]!.duplicateOf).toBeNull();
  });
});

describe("parseBulkEmails — TEST 9: one malformed block loses nothing else", () => {
  it("keeps the other nineteen when one block has no recipient", () => {
    const blocks = Array.from(
      { length: 20 },
      (_, i) => `To: info@firma${i + 1}.cz\nSubject: S${i + 1}\ntext`,
    );
    blocks[7] = "Subject: bez adresáte\ntext bez adresáte";

    const { candidates } = parseBulkEmails(blocks.join("\n\n---\n\n"));

    expect(candidates).toHaveLength(20);
    expect(candidates.filter((c) => c.status === "parsed")).toHaveLength(19);
    expect(candidates.filter((c) => c.status === "needs_review")).toHaveLength(1);
    expect(candidates[7]!.status).toBe("needs_review");
    expect(candidates[7]!.recipient).toBeNull();
    expect(candidates[7]!.reason).toContain("No recipient");
    // The neighbours are untouched.
    expect(candidates[6]!.recipient).toBe("info@firma7.cz");
    expect(candidates[8]!.recipient).toBe("info@firma9.cz");
  });

  it("explains an unreadable address rather than dropping the email", () => {
    const { candidates } = parseBulkEmails("To: info@ bella .cz\nSubject: A\ntext");

    expect(candidates[0]!.status).toBe("needs_review");
    expect(candidates[0]!.reason).toContain("No recipient");
    expect(candidates[0]!.subject).toBe("A");
  });

  it("handles a hundred emails and refuses the overflow loudly", () => {
    const many = Array.from(
      { length: MAX_BULK_EMAILS + 5 },
      (_, i) => `To: info@firma${i}.cz\nSubject: S\ntext`,
    ).join("\n\n---\n\n");

    const { candidates, truncated } = parseBulkEmails(many);
    expect(candidates).toHaveLength(MAX_BULK_EMAILS);
    expect(truncated).toBe(5);
  });
});