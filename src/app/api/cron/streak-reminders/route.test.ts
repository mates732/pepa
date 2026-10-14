import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST, isAuthorizedCronRequest } from "./route";

/**
 * The 19:00 streak reminder scheduler route.
 *
 * Same contract as the follow-up scheduler: Vercel's bearer secret, counts
 * only in the response, a generic 500 on failure, and no verb other than GET.
 * The interesting part is that the route never decides WHEN the reminder is
 * due — the engine does, against the operator's local hour — so this file pins
 * the boundaries of the HTTP surface only.
 */

const SECRET = "cron-secret-value-for-tests-only-1234";
const ENDPOINT = "https://pepa.example.com/api/cron/streak-reminders";

const { processStreakReminder } = vi.hoisted(() => ({
  processStreakReminder: vi.fn(async () => ({
    checked: true,
    reminded: false,
    skippedAlreadyReminded: false,
    skippedNotDue: false,
    skippedNothingAtRisk: false,
    failed: false,
  })),
}));

vi.mock("@/lib/services/streak-reminder-service", () => ({ processStreakReminder }));

function request(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new NextRequest(ENDPOINT, { headers });
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  processStreakReminder.mockClear();
  processStreakReminder.mockResolvedValue({
    checked: true,
    reminded: false,
    skippedAlreadyReminded: false,
    skippedNotDue: false,
    skippedNothingAtRisk: false,
    failed: false,
  });
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
    expect(isAuthorizedCronRequest(request(SECRET))).toBe(false);
    expect(isAuthorizedCronRequest(request(`Basic ${SECRET}`))).toBe(false);
  });

  it("fails closed when CRON_SECRET is not configured", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCronRequest(request(`Bearer ${SECRET}`))).toBe(false);
  });
});

describe("GET /api/cron/streak-reminders", () => {
  it("does not run the engine without authorization", async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(processStreakReminder).not.toHaveBeenCalled();
  });

  it("runs the engine with the correct secret and returns counts only", async () => {
    processStreakReminder.mockResolvedValueOnce({
      checked: true,
      reminded: true,
      skippedAlreadyReminded: false,
      skippedNotDue: false,
      skippedNothingAtRisk: true,
      failed: false,
    });

    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ ok: true, checked: true, reminded: true });
    expect(processStreakReminder).toHaveBeenCalledOnce();
  });

  it("never leaks outreach content in the response", async () => {
    processStreakReminder.mockResolvedValueOnce({
      checked: true,
      reminded: true,
      skippedAlreadyReminded: false,
      skippedNotDue: false,
      skippedNothingAtRisk: false,
      failed: false,
    });

    const response = await GET(request(`Bearer ${SECRET}`));
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/subject|body|email|token|pepa\./i);
  });

  it("returns a generic 500 when the engine throws", async () => {
    processStreakReminder.mockRejectedValueOnce(new Error("supabase exploded at /secret/path"));

    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);

    const text = JSON.stringify(await response.json());
    expect(text).toContain("reminder_failed");
    expect(text).not.toContain("supabase exploded");
    expect(text).not.toContain(SECRET);
  });

  it("reports a failed run honestly rather than as a quiet evening", async () => {
    processStreakReminder.mockResolvedValueOnce({
      checked: true,
      reminded: false,
      skippedAlreadyReminded: false,
      skippedNotDue: false,
      skippedNothingAtRisk: false,
      failed: true,
    });

    const body = await (await GET(request(`Bearer ${SECRET}`))).json();
    expect(body).toMatchObject({ ok: true, failed: true, reminded: false });
  });

  it("refuses POST", async () => {
    const response = await POST();
    expect(response.status).toBe(401);
    expect(processStreakReminder).not.toHaveBeenCalled();
  });
});
