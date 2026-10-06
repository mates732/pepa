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

/** Format D — a machine-generated batch of `--- LEAD NN ---` blocks. */
const FORMAT_D = `--- LEAD 01 ---
To: a@test.cz
Subject: A
Body:
Body A

Follow-up Subject: Follow A
Follow-up Body:
Follow body A

--- LEAD 02 ---
To: b@test.cz
Subject: B
Body:
Body B

Follow-up Subject: Follow B
Follow-up Body:
Follow body B`;

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

describe("parseBulkEmails — format D: LEAD blocks with follow-ups", () => {
  it("splits on the LEAD markers and keeps every body clean", () => {
    const { candidates, splitBy } = parseBulkEmails(FORMAT_D);

    expect(splitBy).toBe("recipient_header");
    // Two leads — one card each, the follow-up carried on the card.
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.recipient)).toEqual(["a@test.cz", "b@test.cz"]);
    // No marker and no follow-up text leaks into a first outreach.
    expect(candidates.every((c) => !String(c.body).includes("LEAD"))).toBe(true);
    expect(candidates.every((c) => !String(c.body).includes("Follow"))).toBe(true);
    // The follow-up is parsed as part of the SAME lead.
    expect(candidates[0]!.followUp).toEqual({
      subject: "Follow A",
      body: "Follow body A",
    });
    expect(candidates[1]!.followUp).toEqual({
      subject: "Follow B",
      body: "Follow body B",
    });
  });

  it("reads the first outreach of each block as the importable row", () => {
    const { candidates } = parseBulkEmails(FORMAT_D);

    expect(candidates[0]!.index).toBe(1);
    expect(candidates[0]!.status).toBe("parsed");
    expect(candidates[0]!.subject).toBe("A");
    expect(candidates[0]!.body).toBe("Body A");
    // The operator is told where the follow-up went.
    expect(candidates[0]!.warnings.join(" ")).toContain("follow-up");
  });

  it("carries the follow-up on the same candidate, not on a card of its own", () => {
    const { candidates } = parseBulkEmails(FORMAT_D);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.index).toBe(1);
    expect(candidates[0]!.followUp).toEqual({
      subject: "Follow A",
      body: "Follow body A",
    });
    expect(candidates[0]!.duplicateOf).toBeNull();
  });

  it("keeps a block without a follow-up to a single row", () => {
    const { candidates } = parseBulkEmails(
      "--- LEAD 01 ---\nTo: a@test.cz\nSubject: A\nBody:\nBody A",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe("parsed");
    expect(candidates[0]!.body).toBe("Body A");
    expect(candidates[0]!.followUp).toBeNull();
    expect(candidates[0]!.warnings).toEqual([]);
  });

  it("drops text typed before the first marker", () => {
    const { candidates } = parseBulkEmails(
      "Here are the leads:\n\n--- LEAD 01 ---\nTo: a@test.cz\nSubject: A\nBody:\nBody A",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("Body A");
  });

  it("strips a rule the operator typed between blocks", () => {
    const { candidates } = parseBulkEmails(
      "--- LEAD 01 ---\nTo: a@test.cz\nSubject: A\nBody:\nBody A\n\n---\n\n--- LEAD 02 ---\nTo: b@test.cz\nSubject: B\nBody:\nBody B",
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.body).toBe("Body A");
    expect(candidates[1]!.body).toBe("Body B");
  });

  it("reads a follow-up that has a body but no subject", () => {
    const { candidates } = parseBulkEmails(
      "--- LEAD 01 ---\nTo: a@test.cz\nSubject: A\nBody:\nBody A\n\nFollow-up Body:\nFollow body A",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.followUp).toEqual({ subject: null, body: "Follow body A" });
  });

  it("reads other decoration around a marker the same way", () => {
    const { candidates } = parseBulkEmails(
      "*** LEAD 01 ***\nTo: a@test.cz\nSubject: A\nBody:\nBody A",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.body).toBe("Body A");
  });

  it("accepts single-digit lead numbers", () => {
    const { candidates } = parseBulkEmails(
      "--- LEAD 1 ---\nTo: a@test.cz\nSubject: A\nBody:\nBody A\n\n--- LEAD 2 ---\nTo: b@test.cz\nSubject: B\nBody:\nBody B",
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.body).toBe("Body A");
    expect(candidates[1]!.body).toBe("Body B");
  });
});

/**
 * The exact batch from the bug report: a pasted run of `--- LEAD NN ---
 * ` blocks, each with a first outreach and a follow-up. Ten blocks
 * must come out as ten cards — the whole failure was one card.
 */
function tenLeadBatch(): string {
  return Array.from(
    { length: 10 },
    (_, i) =>
      `--- LEAD ${String(i + 1).padStart(2, "0")} ---\nTo: lead${i + 1}@example.com\nSubject: Subject ${i + 1}\nBody:\nBody ${i + 1}\n\nFollow-up Subject: Follow-up ${i + 1}\nFollow-up Body:\nFollow-up body ${i + 1}`,
  ).join("\n\n");
}

describe("parseBulkEmails — regression: pasted LEAD batch", () => {
  const THREE_LEADS = `--- LEAD 01 ---
To: first@example.com
Subject: Subject 1
Body:
Body 1

Follow-up Subject: Follow-up 1
Follow-up Body:
Follow-up body 1

--- LEAD 02 ---
To: second@example.com
Subject: Subject 2
Body:
Body 2

Follow-up Subject: Follow-up 2
Follow-up Body:
Follow-up body 2

--- LEAD 03 ---
To: third@example.com
Subject: Subject 3
Body:
Body 3

Follow-up Subject: Follow-up 3
Follow-up Body:
Follow-up body 3`;

  it("splits the batch into one card per lead", () => {
    const result = parseBulkEmails(THREE_LEADS).candidates;

    expect(result).toHaveLength(3);
    expect(result[0]!.recipient).toBe("first@example.com");
    expect(result[1]!.recipient).toBe("second@example.com");
    expect(result[2]!.recipient).toBe("third@example.com");
  });

  it("keeps every marker out of every body", () => {
    const result = parseBulkEmails(THREE_LEADS).candidates;

    expect(result[0]!.body).not.toContain("--- LEAD 02 ---");
    expect(result[1]!.body).not.toContain("--- LEAD 03 ---");
    expect(result.every((c) => !String(c.body).includes("--- LEAD"))).toBe(
      true,
    );
  });

  it("reads each lead's own fields, and its follow-up with it", () => {
    const result = parseBulkEmails(THREE_LEADS).candidates;

    expect(result[0]!.subject).toBe("Subject 1");
    expect(result[0]!.body).toBe("Body 1");
    expect(result[0]!.followUp).toEqual({
      subject: "Follow-up 1",
      body: "Follow-up body 1",
    });
    expect(result[1]!.subject).toBe("Subject 2");
    expect(result[1]!.body).toBe("Body 2");
    expect(result[1]!.followUp).toEqual({
      subject: "Follow-up 2",
      body: "Follow-up body 2",
    });
    expect(result[2]!.subject).toBe("Subject 3");
    expect(result[2]!.body).toBe("Body 3");
    expect(result[2]!.followUp).toEqual({
      subject: "Follow-up 3",
      body: "Follow-up body 3",
    });
  });

  it("returns exactly ten candidates for the ten-lead batch", () => {
    const result = parseBulkEmails(tenLeadBatch());

    // The debugging assertion: the pasted batch is ten cards, not one.
    expect(result.candidates).toHaveLength(10);
    expect(result.candidates.map((c) => c.recipient)).toEqual(
      Array.from({ length: 10 }, (_, i) => `lead${i + 1}@example.com`),
    );
    expect(
      result.candidates.every((c) => !String(c.body).includes("--- LEAD")),
    ).toBe(true);
    expect(result.candidates.every((c) => c.followUp !== null)).toBe(true);
  });
});

describe("parseBulkEmails — regression: follow-up labels are hard field boundaries", () => {
  /** The exact example from the bug report. */
  const BUG_REPORT_EXAMPLE = `--- LEAD 01 ---
To: test@example.com
Subject: Test subject
Body:
Hello,

this is the primary email.

Hezký den,
Matyáš
recepce.tech

Follow-up Subject: Navazuji na nabídku
Follow-up Body:
Dobrý den,

jen navazuji na svůj předchozí e-mail.

Hezký den,
Matyáš
recepce.tech`;

  it("stops the primary body at Follow-up Subject: and reads both halves", () => {
    const { candidates } = parseBulkEmails(BUG_REPORT_EXAMPLE);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.recipient).toBe("test@example.com");
    expect(candidates[0]!.subject).toBe("Test subject");
    expect(candidates[0]!.body).toBe(
      "Hello,\n\nthis is the primary email.\n\nHezký den,\nMatyáš\nrecepce.tech",
    );
    expect(candidates[0]!.followUp).toEqual({
      subject: "Navazuji na nabídku",
      body: "Dobrý den,\n\njen navazuji na svůj předchozí e-mail.\n\nHezký den,\nMatyáš\nrecepce.tech",
    });
    // The labels are boundaries — never content of the primary body.
    expect(candidates[0]!.body).not.toContain("Follow-up Subject:");
    expect(candidates[0]!.body).not.toContain("Follow-up Body:");
    // Nor does the follow-up subject swallow the follow-up body label.
    expect(candidates[0]!.followUp!.subject).not.toContain(
      "Follow-up Body:",
    );
  });

  it("recognises the follow-up labels however they are spelled", () => {
    const spellings: Array<[string, string]> = [
      ["Follow-up Subject:", "Follow-up Body:"],
      ["Follow Up Subject:", "Follow Up Body:"],
      ["Followup Subject:", "Followup Body:"],
      ["Follow-up-subject:", "Follow-up-body:"],
      ["FOLLOW UP SUBJECT:", "FOLLOW UP BODY:"],
    ];

    for (const [subjectLabel, bodyLabel] of spellings) {
      const { candidates } = parseBulkEmails(
        `--- LEAD 01 ---\nTo: a@test.cz\nSubject: A\nBody:\nBody A\n\n${subjectLabel} Follow A\n${bodyLabel}\nFollow body A`,
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.body).toBe("Body A");
      expect(candidates[0]!.followUp).toEqual({
        subject: "Follow A",
        body: "Follow body A",
      });
    }
  });

  it("reads the full ten-lead batch: ten cards, clean bodies, own follow-ups", () => {
    const result = parseBulkEmails(tenLeadBatch());

    expect(result.candidates).toHaveLength(10);
    for (let i = 0; i < 10; i += 1) {
      const card = result.candidates[i]!;
      expect(card.recipient).toBe(`lead${i + 1}@example.com`);
      expect(card.subject).toBe(`Subject ${i + 1}`);
      // The primary body is exactly the first outreach — the
      // follow-up labels never appear in it.
      expect(card.body).toBe(`Body ${i + 1}`);
      expect(card.body).not.toContain("Follow-up Subject");
      expect(card.body).not.toContain("Follow-up Body");
      // The follow-up is this lead's own, not another lead's.
      expect(card.followUp).toEqual({
        subject: `Follow-up ${i + 1}`,
        body: `Follow-up body ${i + 1}`,
      });
      expect(card.status).toBe("parsed");
    }
    // No data leaks between leads: ten distinct recipients.
    expect(new Set(result.candidates.map((c) => c.recipient))).toHaveLength(
      10,
    );
  });
});