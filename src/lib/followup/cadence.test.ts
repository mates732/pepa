import { describe, expect, it } from "vitest";

import {
  delayForFollowUp,
  FOLLOW_UP_CADENCE_DAYS,
  isDue,
  isWithinCadence,
  MAX_FOLLOW_UPS,
  nextFollowUpDueAt,
} from "./cadence";

describe("cadence", () => {
  it("is the documented sequence", () => {
    expect([...FOLLOW_UP_CADENCE_DAYS]).toEqual([4, 7, 10]);
    expect(MAX_FOLLOW_UPS).toBe(3);
  });

  it("maps follow-up numbers to delays after the previous touchpoint", () => {
    expect(delayForFollowUp(1)).toBe(4);
    expect(delayForFollowUp(2)).toBe(7);
    expect(delayForFollowUp(3)).toBe(10);
    expect(delayForFollowUp(4)).toBeNull();
    expect(delayForFollowUp(0)).toBeNull();
    expect(delayForFollowUp(-1)).toBeNull();
  });

  it("stops after follow-up #3", () => {
    expect(isWithinCadence(1)).toBe(true);
    expect(isWithinCadence(3)).toBe(true);
    expect(isWithinCadence(4)).toBe(false);
    expect(isWithinCadence(0)).toBe(false);
  });

  it("computes absolute UTC due dates", () => {
    const sent = new Date("2026-09-30T09:00:00.000Z");

    expect(nextFollowUpDueAt(sent, 1)?.toISOString()).toBe("2026-10-04T09:00:00.000Z");
    expect(nextFollowUpDueAt(sent, 2)?.toISOString()).toBe("2026-10-07T09:00:00.000Z");
    expect(nextFollowUpDueAt(sent, 3)?.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    expect(nextFollowUpDueAt(sent, 4)).toBeNull();
  });

  it("chains: follow-up #2 is measured from follow-up #1", () => {
    const initial = new Date("2026-09-30T09:00:00.000Z");
    const first = nextFollowUpDueAt(initial, 1) as Date;
    const second = nextFollowUpDueAt(first, 2) as Date;

    expect(second.toISOString()).toBe("2026-10-11T09:00:00.000Z");
  });

  it("accepts an ISO string as the previous touchpoint", () => {
    expect(nextFollowUpDueAt("2026-09-30T09:00:00.000Z", 1)?.toISOString()).toBe(
      "2026-10-04T09:00:00.000Z",
    );
  });

  it("returns null for an unparseable touchpoint", () => {
    expect(nextFollowUpDueAt("not-a-date", 1)).toBeNull();
  });
});

describe("isDue", () => {
  const now = new Date("2026-10-02T08:00:00.000Z");

  it("treats a past timestamp as due", () => {
    expect(isDue("2026-10-01T08:00:00.000Z", now)).toBe(true);
  });

  it("treats the exact instant as due", () => {
    expect(isDue(now.toISOString(), now)).toBe(true);
  });

  it("does not treat a future timestamp as due", () => {
    expect(isDue("2026-10-09T08:00:00.000Z", now)).toBe(false);
  });

  it("never treats missing or invalid timestamps as due", () => {
    expect(isDue(null, now)).toBe(false);
    expect(isDue(undefined, now)).toBe(false);
    expect(isDue("", now)).toBe(false);
    expect(isDue("nonsense", now)).toBe(false);
  });

  it("compares instants, not strings or local time", () => {
    // Same UTC instant, different textual offset — still due.
    expect(isDue("2026-10-02T09:00:00.000+01:00", now)).toBe(true);
    expect(isDue("2026-10-02T10:00:00.000+01:00", now)).toBe(false);
  });
});