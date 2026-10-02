import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST, isAuthorizedImportRequest } from "./route";

const SECRET = "import-secret-value-for-tests-only-1234";
const ENDPOINT = "https://pepa.example.com/api/import";

const { createOutreachImport } = vi.hoisted(() => ({ createOutreachImport: vi.fn() }));
vi.mock("@/lib/services/import-service", () => ({ createOutreachImport }));

function request(body?: string, authorization?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new NextRequest(ENDPOINT, {
    method: "POST",
    headers,
    body: body ?? JSON.stringify({}),
  });
}

const validPayload = {
  recipient: "hello@example.com",
  subject: "Quick idea",
  body: "Dobrý den,",
};

beforeEach(() => {
  process.env.IMPORT_SECRET = SECRET;
  createOutreachImport.mockReset();
  createOutreachImport.mockResolvedValue({
    ok: true,
    deepLink: "https://pepa.example.com/import/fp1_abc",
    recipient: "hello@example.com",
    created: true,
    alreadyContacted: false,
    expiresAt: "2026-10-02T12:00:00.000Z",
  });
});

afterEach(() => {
  delete process.env.IMPORT_SECRET;
});

describe("import endpoint authorization", () => {
  it("accepts the exact bearer secret", () => {
    expect(isAuthorizedImportRequest(request(undefined, `Bearer ${SECRET}`))).toBe(true);
    expect(isAuthorizedImportRequest(request(undefined, `bearer ${SECRET}`))).toBe(true);
  });

  it("rejects missing, wrong and malformed credentials", () => {
    expect(isAuthorizedImportRequest(request())).toBe(false);
    expect(isAuthorizedImportRequest(request(undefined, ""))).toBe(false);
    expect(isAuthorizedImportRequest(request(undefined, "Bearer"))).toBe(false);
    expect(isAuthorizedImportRequest(request(undefined, "Bearer wrong"))).toBe(false);
    expect(isAuthorizedImportRequest(request(undefined, SECRET))).toBe(false);
    expect(isAuthorizedImportRequest(request(undefined, `Bearer ${SECRET}x`))).toBe(false);
    expect(isAuthorizedImportRequest(request(undefined, `Basic ${SECRET}`))).toBe(false);
  });

  it("fails closed when IMPORT_SECRET is unset", () => {
    delete process.env.IMPORT_SECRET;
    expect(isAuthorizedImportRequest(request(undefined, `Bearer ${SECRET}`))).toBe(false);
    expect(isAuthorizedImportRequest(request(undefined, "Bearer "))).toBe(false);
  });

  it("401s an unauthenticated POST and never touches the service", async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(createOutreachImport).not.toHaveBeenCalled();
  });

  it("401s a wrong-secret POST", async () => {
    const response = await POST(request(undefined, "Bearer nope"));
    expect(response.status).toBe(401);
    expect(createOutreachImport).not.toHaveBeenCalled();
  });

  it("refuses GET", async () => {
    const response = await GET();
    expect(response.status).toBe(401);
    expect(createOutreachImport).not.toHaveBeenCalled();
  });
});

describe("import endpoint payload handling", () => {
  it("returns the deep link for a valid payload", async () => {
    const response = await POST(
      request(JSON.stringify(validPayload), `Bearer ${SECRET}`),
    );
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ ok: true, status: "created" });
    expect(body.deep_link).toMatch(/^https:\/\/pepa\.example\.com\/import\/fp1_/);
    expect(createOutreachImport).toHaveBeenCalledOnce();
  });

  it("never returns the raw token or a database id", async () => {
    const response = await POST(
      request(JSON.stringify(validPayload), `Bearer ${SECRET}`),
    );
    const body = await response.json();

    // The link contains a token; nothing else in the response may.
    expect(Object.keys(body).sort()).toEqual(
      ["deep_link", "expires_at", "ok", "recipient", "status"].sort(),
    );
    expect(JSON.stringify(body).match(/fp1_/g)?.length).toBe(1);
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await POST(request("{not json", `Bearer ${SECRET}`));
    expect(response.status).toBe(400);
    expect(createOutreachImport).not.toHaveBeenCalled();
  });

  it("maps an invalid payload to 400", async () => {
    createOutreachImport.mockResolvedValueOnce({
      ok: false,
      error: "A subject is required.",
      reason: "invalid_payload",
    });

    const response = await POST(request(JSON.stringify(validPayload), `Bearer ${SECRET}`));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("A subject is required.");
  });

  it("maps an already-contacted recipient to 409", async () => {
    createOutreachImport.mockResolvedValueOnce({
      ok: false,
      error: "Lead already contacted — this recipient has a sent message.",
      reason: "already_contacted",
    });

    const response = await POST(request(JSON.stringify(validPayload), `Bearer ${SECRET}`));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already contacted/i);
  });

  it("maps a storage failure to 500 without leaking detail", async () => {
    createOutreachImport.mockResolvedValueOnce({
      ok: false,
      error: "The imported draft could not be stored.",
      reason: "store_failed",
    });

    const response = await POST(request(JSON.stringify(validPayload), `Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect((await response.json()).error).not.toMatch(/supabase|postgres|select/i);
  });

  it("rejects an oversized body with 413 before touching the service", async () => {
    const huge = JSON.stringify({ ...validPayload, body: "x".repeat(70_000) });
    const response = await POST(request(huge, `Bearer ${SECRET}`));

    expect(response.status).toBe(413);
    expect(createOutreachImport).not.toHaveBeenCalled();
  });

  it("never echoes the submitted payload back", async () => {
    const response = await POST(
      request(JSON.stringify(validPayload), `Bearer ${SECRET}`),
    );
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain("Dobrý den");
    expect(text).not.toContain("Quick idea");
  });
});