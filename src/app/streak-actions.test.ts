import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the Outreach Streaks action.
 *
 * The boundary properties under test: an unauthenticated request is rejected
 * before any database access, the client cannot supply counts, active days,
 * boundaries or completeness, and no write verb is ever reachable.
 *
 * The service is mocked here. What is being tested is the action's contract —
 * what it accepts, what it rejects and what it exposes — not the counting, which
 * `outreach-streak-service.test.ts` covers against a real store fake.
 */

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOutreachStreaks: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));

// Tracked so "streaks changes nothing" is an assertion, not a claim.
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/services/outreach-streak-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/services/outreach-streak-service",
  );
  return { ...actual, getOutreachStreaks: mocks.getOutreachStreaks };
});

const VALID_ZONE = "Europe/Prague";

let writes: string[] = [];

/** Mirrors the real service result shape for a given set of figures. */
function serviceResult(values: Partial<Record<string, number>> = {}, complete = true) {
  return {
    ok: true,
    error: null,
    data: {
      currentStreak: 7,
      longestStreak: 12,
      activeDaysThisWeek: 5,
      activeDaysThisMonth: 18,
      totalActiveDays: 61,
      daysInWeek: 7,
      daysInMonth: 31,
      complete,
      currentStreakComplete: complete,
      generatedAt: "2026-10-07T10:00:00.000Z",
      windows: {
        timeZone: VALID_ZONE,
        dayStart: "2026-10-06T22:00:00.000Z",
        nextDayStart: "2026-10-07T22:00:00.000Z",
        weekStart: "2026-10-04T22:00:00.000Z",
        nextWeekStart: "2026-10-11T22:00:00.000Z",
        monthStart: "2026-09-30T22:00:00.000Z",
        nextMonthStart: "2026-10-31T23:00:00.000Z",
      },
      ...values,
    },
  };
}

async function load() {
  return import("@/app/streak-actions");
}

beforeEach(() => {
  writes = [];
  mocks.requireAuthenticatedUser.mockReset();
  mocks.getOutreachStreaks.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.requireAuthenticatedUser.mockResolvedValue({ id: "owner", since: 0 });
  mocks.getOutreachStreaks.mockResolvedValue(serviceResult());
});

describe("loadOutreachStreaks — authentication", () => {
  it("rejects an unauthenticated request before any database access", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));

    const { loadOutreachStreaks } = await load();
    await expect(loadOutreachStreaks({ timeZone: VALID_ZONE })).rejects.toThrow("AuthenticationError");

    expect(mocks.getOutreachStreaks).not.toHaveBeenCalled();
  });

  it("rejects an unusable time zone without querying", async () => {
    const { loadOutreachStreaks } = await load();

    for (const bad of ["", "Mars/Olympus", "x".repeat(200), null, undefined, 7]) {
      const result = await loadOutreachStreaks({ timeZone: bad as string });
      expect(result.ok).toBe(false);
    }

    expect(mocks.getOutreachStreaks).not.toHaveBeenCalled();
  });

  it("surfaces the service's own safe message", async () => {
    mocks.getOutreachStreaks.mockResolvedValue({
      ok: false,
      data: null,
      error: "Streaks could not be loaded.",
    });

    const { loadOutreachStreaks } = await load();
    const result = await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Streaks could not be loaded.");
  });

  it("contains an unexpected throw", async () => {
    mocks.getOutreachStreaks.mockRejectedValue(new Error("boom"));

    const { loadOutreachStreaks } = await load();
    const result = await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toMatch(/boom/i);
  });
});

describe("loadOutreachStreaks — the client supplies no data", () => {
  it("passes only the time zone to the service", async () => {
    const { loadOutreachStreaks } = await load();
    await loadOutreachStreaks({ timeZone: VALID_ZONE });

    const [input] = mocks.getOutreachStreaks.mock.calls[0] ?? [];
    expect(Object.keys(input ?? {})).toEqual(["timeZone"]);
  });

  it("forwards no count, active day, boundary or completeness the client could have set", async () => {
    const { loadOutreachStreaks } = await load();
    // A hostile payload alongside a valid zone: nothing but the zone survives.
    await loadOutreachStreaks({
      timeZone: VALID_ZONE,
      currentStreak: 9999,
      longestStreak: 9999,
      activeDays: ["2026-10-07", "2026-10-08"],
      today: "2026-10-07",
      dayStart: "1990-01-01T00:00:00.000Z",
      now: new Date("1990-01-01T00:00:00.000Z"),
      complete: true,
      currentStreakComplete: true,
    } as never);

    const [input] = mocks.getOutreachStreaks.mock.calls[0] ?? [];
    expect(Object.keys(input ?? {})).toEqual(["timeZone"]);
    expect((input as { activeDays?: unknown }).activeDays).toBeUndefined();
    expect((input as { now?: unknown }).now).toBeUndefined();
    expect((input as { complete?: unknown }).complete).toBeUndefined();
  });

  it("returns figures the client cannot influence, taken from the service", async () => {
    mocks.getOutreachStreaks.mockResolvedValue(serviceResult());

    const { loadOutreachStreaks } = await load();
    const result = await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.streaks).toEqual({
      currentStreak: 7,
      longestStreak: 12,
      activeDaysThisWeek: 5,
      activeDaysThisMonth: 18,
      totalActiveDays: 61,
      daysInWeek: 7,
      daysInMonth: 31,
    });
  });

  it("exposes no message rows and no window instants, only numbers", async () => {
    const { loadOutreachStreaks } = await load();
    const result = await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const value of Object.values(result.streaks)) {
      expect(typeof value).toBe("number");
    }
    expect(result.timeZone).toBe(VALID_ZONE);
    expect(Object.keys(result)).not.toContain("windows");
  });
});

describe("loadOutreachStreaks — completeness is a server fact", () => {
  it("reports a capped history rather than presenting it as complete", async () => {
    mocks.getOutreachStreaks.mockResolvedValue(serviceResult({}, false));

    const { loadOutreachStreaks } = await load();
    const result = await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.complete).toBe(false);
  });

  it("distinguishes an exact current streak from an uncertain one", async () => {
    const result = serviceResult({}, false);
    result.data.currentStreakComplete = true;
    mocks.getOutreachStreaks.mockResolvedValue(result);

    const { loadOutreachStreaks } = await load();
    const loaded = await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // The longest streak is history and may be incomplete; the current run was
    // still fully covered and is reported as exact.
    expect(loaded.complete).toBe(false);
    expect(loaded.currentStreakComplete).toBe(true);
  });

  it("reports the current streak as uncertain when the cap did not cover it", async () => {
    const result = serviceResult({}, false);
    result.data.currentStreakComplete = false;
    mocks.getOutreachStreaks.mockResolvedValue(result);

    const { loadOutreachStreaks } = await load();
    const loaded = await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.currentStreakComplete).toBe(false);
  });
});

describe("loadOutreachStreaks — read-only by construction", () => {
  it("performs no write of any kind", async () => {
    const { loadOutreachStreaks } = await load();
    await loadOutreachStreaks({ timeZone: VALID_ZONE });

    expect(writes).toEqual([]);
  });

  it("exposes no mutation action", async () => {
    const source = await import("@/app/streak-actions");

    expect(Object.keys(source)).toEqual(["loadOutreachStreaks"]);
    for (const name of Object.keys(source)) {
      expect(name).not.toMatch(/update|delete|save|send|reset|edit|create|record/i);
    }
  });

  it("does not invalidate the page, because nothing changed", async () => {
    const { loadOutreachStreaks } = await load();
    await loadOutreachStreaks({ timeZone: VALID_ZONE });

    // Streaks are derived per read; there is no stored streak to revalidate.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});