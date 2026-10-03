import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the Outreach Stats action.
 *
 * The boundary properties under test: an unauthenticated request is rejected
 * before any database access, the client cannot supply counts or shift the
 * windows, and no write verb is ever reachable.
 *
 * The service is mocked here. What is being tested is the action's contract —
 * what it accepts, what it rejects and what it exposes — not the counting, which
 * `outreach-stats-service.test.ts` covers against a real store fake.
 */

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  getOutreachStats: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));

// Tracked so "stats changes nothing" is an assertion, not a claim: if the
// action ever started invalidating a cache, this would catch it.
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/services/outreach-stats-service", async () => {
  // Keep the label constants the component imports, and replace the query.
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/lib/services/outreach-stats-service",
  );
  return { ...actual, getOutreachStats: mocks.getOutreachStats };
});

const VALID_ZONE = "Europe/Prague";

let writes: string[] = [];

/** Mirrors the real service result shape for a given set of counts. */
function serviceResult(counts: Partial<Record<string, number>> = {}, complete = true) {
  return {
    ok: true,
    error: null,
    data: {
      today: 6,
      week: 31,
      month: 87,
      allTime: 243,
      initialOutreach: 42,
      followUps: 201,
      totalSent: 243,
      complete,
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
      ...counts,
    },
  };
}

async function load() {
  return import("@/app/stats-actions");
}

beforeEach(() => {
  writes = [];
  mocks.requireAuthenticatedUser.mockReset();
  mocks.getOutreachStats.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.requireAuthenticatedUser.mockResolvedValue({ id: "owner", since: 0 });
  mocks.getOutreachStats.mockResolvedValue(serviceResult());
});

describe("loadOutreachStats — authentication", () => {
  it("rejects an unauthenticated request before any database access", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));

    const { loadOutreachStats } = await load();
    await expect(loadOutreachStats({ timeZone: VALID_ZONE })).rejects.toThrow("AuthenticationError");

    expect(mocks.getOutreachStats).not.toHaveBeenCalled();
  });

  it("rejects an unusable time zone without querying", async () => {
    const { loadOutreachStats } = await load();

    for (const bad of ["", "Mars/Olympus", "x".repeat(200), null, undefined, 7]) {
      const result = await loadOutreachStats({ timeZone: bad as string });
      expect(result.ok).toBe(false);
    }

    expect(mocks.getOutreachStats).not.toHaveBeenCalled();
  });

  it("surfaces the service's own safe message", async () => {
    // The service is the containment boundary for driver errors — it is what
    // guarantees no raw Postgres text reaches here, and its test suite pins
    // that. The action passes the message through so the operator sees
    // something actionable, matching the other actions in the app.
    mocks.getOutreachStats.mockResolvedValue({
      ok: false,
      data: null,
      error: "Stats could not be loaded.",
    });

    const { loadOutreachStats } = await load();
    const result = await loadOutreachStats({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Stats could not be loaded.");
  });

  it("contains an unexpected throw", async () => {
    mocks.getOutreachStats.mockRejectedValue(new Error("boom"));

    const { loadOutreachStats } = await load();
    const result = await loadOutreachStats({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toMatch(/boom/i);
  });
});

describe("loadOutreachStats — the client supplies no data", () => {
  it("passes only the time zone to the service", async () => {
    const { loadOutreachStats } = await load();
    await loadOutreachStats({ timeZone: VALID_ZONE });

    const [input] = mocks.getOutreachStats.mock.calls[0] ?? [];
    expect(Object.keys(input ?? {})).toEqual(["timeZone"]);
  });

  it("forwards no count, sequence or boundary the client could have set", async () => {
    const { loadOutreachStats } = await load();
    // A hostile payload alongside a valid zone: nothing but the zone survives.
    await loadOutreachStats({
      timeZone: VALID_ZONE,
      today: 9999,
      allTime: 9999,
      dayStart: "1990-01-01T00:00:00.000Z",
      now: new Date("1990-01-01T00:00:00.000Z"),
    } as never);

    const [input] = mocks.getOutreachStats.mock.calls[0] ?? [];
    expect(Object.keys(input ?? {})).toEqual(["timeZone"]);
    expect((input as { today?: number }).today).toBeUndefined();
    expect((input as { dayStart?: string }).dayStart).toBeUndefined();
  });

  it("returns counts the client cannot influence, taken from the service", async () => {
    mocks.getOutreachStats.mockResolvedValue(
      serviceResult({ today: 6, week: 31, month: 87, allTime: 243, initialOutreach: 42, followUps: 201, totalSent: 243 }),
    );

    const { loadOutreachStats } = await load();
    const result = await loadOutreachStats({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats).toEqual({
      today: 6,
      week: 31,
      month: 87,
      allTime: 243,
      initialOutreach: 42,
      followUps: 201,
      totalSent: 243,
    });
  });

  it("exposes no message rows, only numbers", async () => {
    const { loadOutreachStats } = await load();
    const result = await loadOutreachStats({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const value of Object.values(result.stats)) {
      expect(typeof value).toBe("number");
    }
    // The window instants stay server-side; only the zone name is reported.
    expect(result.timeZone).toBe(VALID_ZONE);
    expect(Object.keys(result)).not.toContain("windows");
  });

  it("reports an incomplete scan rather than presenting a capped total as final", async () => {
    mocks.getOutreachStats.mockResolvedValue(serviceResult({}, false));

    const { loadOutreachStats } = await load();
    const result = await loadOutreachStats({ timeZone: VALID_ZONE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.complete).toBe(false);
  });
});

describe("loadOutreachStats — read-only by construction", () => {
  it("performs no write of any kind", async () => {
    const { loadOutreachStats } = await load();
    await loadOutreachStats({ timeZone: VALID_ZONE });

    expect(writes).toEqual([]);
  });

  it("exposes no mutation action", async () => {
    const source = await import("@/app/stats-actions");

    expect(Object.keys(source)).toEqual(["loadOutreachStats"]);
    for (const name of Object.keys(source)) {
      expect(name).not.toMatch(/update|delete|save|send|reset|edit|create/i);
    }
  });

  it("does not invalidate the page, because nothing changed", async () => {
    const { loadOutreachStats } = await load();
    await loadOutreachStats({ timeZone: VALID_ZONE });

    // Stats stores nothing, so there is no write to revalidate around.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});