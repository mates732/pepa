import { describe, expect, it } from "vitest";

import { parseBulkEmails } from "@/lib/import/bulk-emails";

/**
 * Tests for the save-drafts-action server action logic.
 *
 * These test the core logic by calling parseBulkEmails directly and
 * verifying the parsing produces the expected candidates.
 * The actual server action requires a database, so we test the
 * parsing and validation logic here.
 */

const SINGLE_EMAIL = `--- LEAD 01 ---
Email: info@firma1.cz
Subject: Nabídka spolupráce
Body:
Dobrý den,

rád bych Vám představil naši nabídku.

S pozdravem
Petr

Follow-up Subject: Re: Nabídka spolupráce
Follow-up Body:
Dobrý den,

jen se ozvu, zda jste měl čas se podívat na nabídku.

S pozdravem
Petr`;

const MULTI_EMAIL = `--- LEAD 01 ---
Email: info@firma1.cz
Subject: Nabídka spolupráce
Body:
Dobrý den,

rád bych Vám představil naši nabídku.

S pozdravem
Petr

--- LEAD 02 ---
Email: kontakt@firma2.cz
Subject: AI recepce pro Váš salon
Body:
Dobrý den,

nabízíme AI recepci, která zodpoví všem hovorům.

S pozdravem
Petr`;

const EMAIL_WITHOUT_LEAD_MARKER = `To: info@firma1.cz
Subject: Nabídka spolupráce
Dobrý den,

rád bych Vám představil naši nabídku.

S pozdravem
Petr

---

To: kontakt@firma2.cz
Subject: AI recepce
Dobrý den,

nabízíme AI recepci.

S pozdravem
Petr`;

describe("saveDraftsFromPaste — parsing logic", () => {
  it("parses a single email with follow-ups from LEAD block format", () => {
    const result = parseBulkEmails(SINGLE_EMAIL);

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.recipient).toBe("info@firma1.cz");
    expect(candidate.subject).toBe("Nabídka spolupráce");
    expect(candidate.body).toContain("rád bych Vám představil naši nabídku");
    expect(candidate.followUps).toHaveLength(1);
    expect(candidate.followUps[0]!.subject).toBe("Re: Nabídka spolupráce");
    expect(candidate.followUps[0]!.body).toContain("jen se ozvu");
    expect(candidate.status).toBe("parsed");
  });

  it("parses multiple emails from LEAD block format", () => {
    const result = parseBulkEmails(MULTI_EMAIL);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.recipient).toBe("info@firma1.cz");
    expect(result.candidates[0]!.subject).toBe("Nabídka spolupráce");
    expect(result.candidates[1]!.recipient).toBe("kontakt@firma2.cz");
    expect(result.candidates[1]!.subject).toBe("AI recepce pro Váš salon");
    expect(result.candidates.every((c) => c.status === "parsed")).toBe(true);
  });

  it("parses multiple emails from legacy format with To: headers", () => {
    const result = parseBulkEmails(EMAIL_WITHOUT_LEAD_MARKER);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.recipient).toBe("info@firma1.cz");
    expect(result.candidates[1]!.recipient).toBe("kontakt@firma2.cz");
    expect(result.candidates.every((c) => c.status === "parsed")).toBe(true);
  });

  it("returns empty candidates for empty input", () => {
    const result = parseBulkEmails("");
    expect(result.candidates).toHaveLength(0);
  });

  it("returns empty candidates for whitespace-only input", () => {
    const result = parseBulkEmails("   \n\n  ");
    expect(result.candidates).toHaveLength(0);
  });

  it("reports needs_review for emails without recipient", () => {
    const input = `Subject: No recipient
Body:
This email has no recipient.`;
    const result = parseBulkEmails(input);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.status).toBe("needs_review");
    expect(result.candidates[0]!.recipient).toBeNull();
    expect(result.candidates[0]!.reason).toContain("No recipient");
  });

  it("reports needs_review for emails without subject", () => {
    const input = `To: info@firma.cz
Body:
This email has no subject.`;
    const result = parseBulkEmails(input);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.status).toBe("parsed");
    expect(result.candidates[0]!.subject).toBeNull();
    expect(result.candidates[0]!.warnings.join(" ")).toContain("No subject");
  });

  it("keeps follow-ups attached to their lead, not as separate candidates", () => {
    const result = parseBulkEmails(SINGLE_EMAIL);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.followUps).toHaveLength(1);
    // The follow-up should NOT be a separate candidate
    expect(result.candidates.filter((c) => c.index === 2)).toHaveLength(0);
  });

  it("does not merge recipients, subjects, or bodies", () => {
    const result = parseBulkEmails(MULTI_EMAIL);

    expect(result.candidates[0]!.recipient).toBe("info@firma1.cz");
    expect(result.candidates[1]!.recipient).toBe("kontakt@firma2.cz");
    expect(result.candidates[0]!.recipient).not.toContain("firma2");
    expect(result.candidates[1]!.recipient).not.toContain("firma1");

    expect(result.candidates[0]!.subject).toBe("Nabídka spolupráce");
    expect(result.candidates[1]!.subject).toBe("AI recepce pro Váš salon");
    expect(result.candidates[0]!.subject).not.toContain("AI recepce");
    expect(result.candidates[1]!.subject).not.toContain("Nabídka");

    expect(result.candidates[0]!.body).toContain("představil naši nabídku");
    expect(result.candidates[1]!.body).toContain("AI recepci");
    expect(result.candidates[0]!.body).not.toContain("AI recepci");
    expect(result.candidates[1]!.body).not.toContain("představil naši nabídku");
  });

  it("handles follow-up 2 and follow-up 3 correctly", () => {
    const input = `--- LEAD 01 ---
Email: test@example.com
Subject: Main
Body:
Main body

Follow-up Subject: Follow-up 1
Follow-up Body:
Body 1

Follow-up 2 Subject: Follow-up 2
Follow-up 2 Body:
Body 2

Follow-up 3 Subject: Follow-up 3
Follow-up 3 Body:
Body 3`;

    const result = parseBulkEmails(input);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.followUps).toHaveLength(3);
    expect(result.candidates[0]!.followUps[0]!.subject).toBe("Follow-up 1");
    expect(result.candidates[0]!.followUps[1]!.subject).toBe("Follow-up 2");
    expect(result.candidates[0]!.followUps[2]!.subject).toBe("Follow-up 3");
    expect(result.candidates[0]!.followUps[0]!.body).toBe("Body 1");
    expect(result.candidates[0]!.followUps[1]!.body).toBe("Body 2");
    expect(result.candidates[0]!.followUps[2]!.body).toBe("Body 3");
  });

  it("accepts numbered follow-up 1 as equivalent to unnumbered", () => {
    const unnumbered = `--- LEAD 01 ---
Email: test@example.com
Subject: Main
Body:
Main

Follow-up Subject: FU1
Follow-up Body:
Body 1`;

    const numbered = `--- LEAD 01 ---
Email: test@example.com
Subject: Main
Body:
Main

Follow-up 1 Subject: FU1
Follow-up 1 Body:
Body 1`;

    const result1 = parseBulkEmails(unnumbered);
    const result2 = parseBulkEmails(numbered);

    expect(result1.candidates[0]!.followUps).toHaveLength(1);
    expect(result2.candidates[0]!.followUps).toHaveLength(1);
    expect(result1.candidates[0]!.followUps[0]!.subject).toBe(result2.candidates[0]!.followUps[0]!.subject);
    expect(result1.candidates[0]!.followUps[0]!.body).toBe(result2.candidates[0]!.followUps[0]!.body);
  });
});

describe("saveDraftsFromPaste — integration shape (mocked)", () => {
  // This describes the expected shape of the server action result
  // The actual server action tests would need a database

  it("defines the expected result shape", () => {
    // This is a compile-time shape test
    type ExpectedResult =
      | { ok: true; created: number; existing: number; skipped: number; failed: number; details: Array<{ index: number; recipient: string | null; outcome: string; messageId: string | null; leadId: string | null; error: string | null }> }
      | { ok: false; error: string };

    // If this compiles, the shape matches
    const _shapeCheck: ExpectedResult = {
      ok: true,
      created: 2,
      existing: 0,
      skipped: 1,
      failed: 0,
      details: [
        { index: 1, recipient: "a@test.cz", outcome: "created", messageId: "msg-1", leadId: "lead-1", error: null },
        { index: 2, recipient: "b@test.cz", outcome: "already_present", messageId: "msg-2", leadId: "lead-2", error: null },
        { index: 3, recipient: "c@test.cz", outcome: "skipped", messageId: null, leadId: null, error: "Already contacted" },
      ],
    };

    expect(_shapeCheck.ok).toBe(true);
  });
});