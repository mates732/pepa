import { describe, expect, it } from "vitest";

import {
  MAX_IMPORT_BODY,
  MAX_IMPORT_PAYLOAD_BYTES,
  MAX_IMPORT_SUBJECT,
  importPayloadBytes,
  validateOutreachImport,
} from "./outreach-import";

const valid = {
  recipient: "hello@example.com",
  subject: "Quick idea for Example Business",
  body: "Dobrý den,\n\nposílám krátký návrh.\n\nS pozdravem",
};

describe("validateOutreachImport — happy path", () => {
  it("accepts and normalizes a well-formed payload", () => {
    const result = validateOutreachImport(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload).toEqual({
      recipient: "hello@example.com",
      subject: "Quick idea for Example Business",
      body: "Dobrý den,\n\nposílám krátký návrh.\n\nS pozdravem",
      companyName: null,
      contactName: null,
    });
  });

  it("preserves line breaks in the body", () => {
    const result = validateOutreachImport({ ...valid, body: "line one\n\nline two\nline three" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body).toBe("line one\n\nline two\nline three");
  });

  it("accepts optional company and contact context", () => {
    const result = validateOutreachImport({
      ...valid,
      companyName: "Example Business",
      contactName: "Jan Novák",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.companyName).toBe("Example Business");
    expect(result.payload.contactName).toBe("Jan Novák");
  });
});

describe("validateOutreachImport — normalization (server-side, never trusted)", () => {
  it("normalizes case", () => {
    const result = validateOutreachImport({ ...valid, recipient: "  Hello@Example.COM " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.recipient).toBe("hello@example.com");
  });

  it("unwraps an angle-bracket address", () => {
    const result = validateOutreachImport({
      ...valid,
      recipient: "Jan Novák <Hello@Example.com>",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.recipient).toBe("hello@example.com");
  });

  it("strips surrounding punctuation and whitespace", () => {
    const result = validateOutreachImport({ ...valid, recipient: "«hello@example.com»" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.recipient).toBe("hello@example.com");
  });

  it("trims the subject and body but keeps inner spacing", () => {
    const result = validateOutreachImport({
      ...valid,
      subject: "  Předmět  ",
      body: "\n\n  tělo textu  \n\n",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.subject).toBe("Předmět");
    expect(result.payload.body).toBe("tělo textu");
  });
});

describe("validateOutreachImport — rejection", () => {
  const expectRejected = (input: unknown, match: RegExp) => {
    const result = validateOutreachImport(input as typeof valid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(match);
  };

  it("rejects a missing recipient", () => {
    expectRejected({ ...valid, recipient: "" }, /recipient email is required/i);
    expectRejected({ ...valid, recipient: undefined }, /recipient email is required/i);
    expectRejected({ ...valid, recipient: "   " }, /recipient email is required/i);
    expectRejected({ ...valid, recipient: 42 }, /recipient email is required/i);
  });

  it("rejects a syntactically invalid recipient", () => {
    expectRejected({ ...valid, recipient: "not-an-email" }, /not a valid email/i);
    expectRejected({ ...valid, recipient: "a@b" }, /not a valid email/i);
    expectRejected({ ...valid, recipient: "@example.com" }, /not a valid email/i);
    expectRejected({ ...valid, recipient: "hello @example.com" }, /not a valid email/i);
  });

  it("rejects an empty subject", () => {
    expectRejected({ ...valid, subject: "" }, /subject is required/i);
    expectRejected({ ...valid, subject: "    " }, /subject is required/i);
    expectRejected({ ...valid, subject: null }, /subject is required/i);
  });

  it("rejects an empty body", () => {
    expectRejected({ ...valid, body: "" }, /body is required/i);
    expectRejected({ ...valid, body: "\n\n  \n" }, /body is required/i);
    expectRejected({ ...valid, body: undefined }, /body is required/i);
  });

  it("rejects an oversized subject", () => {
    expectRejected({ ...valid, subject: "x".repeat(MAX_IMPORT_SUBJECT + 1) }, /too long/i);
  });

  it("accepts a subject exactly at the limit", () => {
    const result = validateOutreachImport({ ...valid, subject: "x".repeat(MAX_IMPORT_SUBJECT) });
    expect(result.ok).toBe(true);
  });

  it("rejects an oversized body", () => {
    expectRejected({ ...valid, body: "x".repeat(MAX_IMPORT_BODY + 1) }, /too long/i);
  });

  it("accepts a body exactly at the limit", () => {
    const result = validateOutreachImport({ ...valid, body: "x".repeat(MAX_IMPORT_BODY) });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object payload", () => {
    expectRejected("a string", /json object/i);
    expectRejected(null, /json object/i);
    expectRejected(42, /json object/i);
  });

  it("rejects non-string field types instead of coercing them", () => {
    expectRejected({ ...valid, subject: { toString: () => "sneaky" } }, /subject is required/i);
    expectRejected({ ...valid, body: ["line"] }, /body is required/i);
  });

  it("strips control characters but keeps newlines and tabs", () => {
    const result = validateOutreachImport({
      ...valid,
      body: "line one\r\n\tindented\u0000\u0007end",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.body).toBe("line one\n\tindentedend");
  });

  it("truncates absurd optional names rather than rejecting the payload", () => {
    const result = validateOutreachImport({ ...valid, companyName: "c".repeat(500) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.companyName).toHaveLength(200);
  });
});

describe("importPayloadBytes", () => {
  it("measures the serialized payload", () => {
    expect(importPayloadBytes(valid)).toBeGreaterThan(0);
    expect(importPayloadBytes(valid)).toBeLessThan(MAX_IMPORT_PAYLOAD_BYTES);
  });

  it("flags a payload beyond the route cap", () => {
    const huge = { ...valid, body: "x".repeat(MAX_IMPORT_PAYLOAD_BYTES) };
    expect(importPayloadBytes(huge)).toBeGreaterThan(MAX_IMPORT_PAYLOAD_BYTES);
  });

  it("does not throw on a missing payload", () => {
    expect(importPayloadBytes(undefined as unknown as typeof valid)).toBeGreaterThan(0);
  });
});