import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST, isAuthorizedCronRequest } from "./route";

const SECRET = "cron-secret-value-for-tests-only-1234";
const ENDPOINT = "https://pepa.example.com/api/cron/followups";

const { processDueFollowUps } = vi.hoisted(() => ({
  processDueFollowUps: vi.fn(async () => ({
    examined: 0,
    notified: 0,
    skippedAlreadyNotified: 0,
    skippedBusy: 0,
    skippedMaxCadence: 0,
    skippedAlreadySent: 0,
    skippedUnrecorded: 0,
    skippedAmbiguous: 0,
    failed: 0,
  })),
}));

vi.mock("@/lib/services/follow-up-service", () => ({ processDueFollowUps }));

function request(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new NextRequest(ENDPOINT, { headers });
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  processDueFollowUps.mockClear();
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("cron authorization", () => {
  it("accepts the exact bearer secret", () => {
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}`))).toBe(true);
    expect(isAuthorizedCronRequest(request(`bearer ${SECRET}`))).toBe(true);
    expect(isAuthorizedCronRequest(request(`Bearer   ${SECRET}  `))).toBe(true);
  });

  it("rejects wrong, partial and malformed credentials", () => {
    expect(isAuthorizedCronRequest(request())).toBe(false);
    expect(isAuthorizedCronRequest(request(""))).toBe(false);
    expect(isAuthorizedCronRequest(request("Bearer"))).toBe(false);
    expect(isAuthorizedCronRequest(request("Bearer wrong"))).toBe(false);
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}x`))).toBe(false);
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET.slice(0, -1)}`))).toBe(false);
    expect(isAuthorizedCronRequest(request(SECRET))).toBe(false);
    expect(isAuthorizedCronRequest(request(`Basic ${SECRET}`))).toBe(false);
  });

  it("fails closed when CRON_SECRET is not configured", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}`))).toBe(false);
    expect(isAuthorizedCronRequest(request(`Bearer ${""}`))).toBe(false);
  });
});

describe("GET /api/cron/followups", () => {
  it("does not run the engine without authorization", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(processDueFollowUps).not.toHaveBeenCalled();
  });

  it("runs the engine with the correct secret and returns counts only", async () => {
    processDueFollowUps.mockResolvedValueOnce({
      examined: 2,
      notified: 1,
      skippedAlreadyNotified: 1,
      skippedBusy: 0,
      skippedMaxCadence: 0,
      skippedAlreadySent: 0,
      skippedUnrecorded: 0,
      skippedAmbiguous: 0,
      failed: 0,
    });

    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ ok: true, examined: 2, notified: 1 });
    expect(processDueFollowUps).toHaveBeenCalledOnce();
  });

  it("never leaks outreach content in the response", async () => {
    processDueFollowUps.mockResolvedValueOnce({
      examined: 1,
      notified: 1,
      skippedAlreadyNotified: 0,
      skippedBusy: 0,
      skippedMaxCadence: 0,
      skippedAlreadySent: 0,
      skippedUnrecorded: 0,
      skippedAmbiguous: 0,
      failed: 0,
    });

    const response = await GET(request(`Bearer ${SECRET}`));
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("@");
    expect(text).not.toContain("fp1_");
    expect(text).not.toMatch(/subject|body|email/i);
  });

  it("returns a generic 500 when the engine throws", async () => {
    processDueFollowUps.mockRejectedValueOnce(new Error("supabase exploded at /secret/path"));

    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);

    const text = JSON.stringify(await response.json());
    expect(text).toContain("scheduler_failed");
    expect(text).not.toContain("supabase exploded");
    expect(text).not.toContain(SECRET);
  });

  it("reports the Phase 8A skip reasons as counts", async () => {
    processDueFollowUps.mockResolvedValueOnce({
      examined: 4,
      notified: 1,
      skippedAlreadyNotified: 1,
      skippedBusy: 0,
      skippedMaxCadence: 0,
      skippedAlreadySent: 1,
      skippedUnrecorded: 1,
      skippedAmbiguous: 0,
      failed: 0,
    });

    const response = await GET(request(`Bearer ${SECRET}`));
    const body = await response.json();

    // An already-sent follow-up and an unrecorded one are reported honestly
    // rather than passing silently, so a misconfigured lead is visible in the
    // cron response instead of looking like a healthy run.
    expect(body).toMatchObject({
      ok: true,
      notified: 1,
      skippedAlreadySent: 1,
      skippedUnrecorded: 1,
    });
  });

  it("refuses POST", async () => {
    const response = await POST();
    expect(response.status).toBe(401);
    expect(processDueFollowUps).not.toHaveBeenCalled();
  });
});