import { describe, expect, it } from "vitest";

import {
  addBusinessDays,
  delayForFollowUp,
  FOLLOW_UP_CADENCE_DAYS,
  isBusinessDay,
  isDue,
  isWithinCadence,
  MAX_FOLLOW_UPS,
  nextFollowUpDueAt,
  parseFollowUpCadence,
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

  it("honours a custom cadence", () => {
    const cadence = [2, 4];

    expect(delayForFollowUp(1, cadence)).toBe(2);
    expect(delayForFollowUp(2, cadence)).toBe(4);
    expect(delayForFollowUp(3, cadence)).toBeNull();
    expect(isWithinCadence(1, cadence)).toBe(true);
    expect(isWithinCadence(2, cadence)).toBe(true);
    expect(isWithinCadence(3, cadence)).toBe(false);
  });

  it("stops after follow-up #3", () => {
    expect(isWithinCadence(1)).toBe(true);
    expect(isWithinCadence(3)).toBe(true);
    expect(isWithinCadence(4)).toBe(false);
    expect(isWithinCadence(0)).toBe(false);
  });

  it("computes due dates in business days", () => {
    // Wednesday 11:00 Europe/Prague.
    const sent = new Date("2026-09-30T09:00:00.000Z");

    // +4 business days: Thu, Fri, Mon, Tue.
    expect(nextFollowUpDueAt(sent, 1)?.toISOString()).toBe(
      "2026-10-06T09:00:00.000Z",
    );
    // +7 business days: … Fri 9 October.
    expect(nextFollowUpDueAt(sent, 2)?.toISOString()).toBe(
      "2026-10-09T09:00:00.000Z",
    );
    // +10 business days: … Wed 14 October.
    expect(nextFollowUpDueAt(sent, 3)?.toISOString()).toBe(
      "2026-10-14T09:00:00.000Z",
    );
    expect(nextFollowUpDueAt(sent, 4)).toBeNull();
  });

  it("chains: follow-up #2 is measured from follow-up #1's send", () => {
    const initial = new Date("2026-09-30T09:00:00.000Z");
    const first = nextFollowUpDueAt(initial, 1) as Date;
    const second = nextFollowUpDueAt(first, 2) as Date;

    // Tue 6 Oct + 7 business days → Thu 15 Oct.
    expect(second.toISOString()).toBe("2026-10-15T09:00:00.000Z");
  });

  it("accepts an ISO string as the previous touchpoint", () => {
    expect(nextFollowUpDueAt("2026-09-30T09:00:00.000Z", 1)?.toISOString()).toBe(
      "2026-10-06T09:00:00.000Z",
    );
  });

  it("returns null for an unparseable touchpoint", () => {
    expect(nextFollowUpDueAt("not-a-date", 1)).toBeNull();
  });
});

describe("business days — Europe/Prague", () => {
  it("counts Monday to Friday only", () => {
    // 2026-10-05 is a Monday; 2026-10-10 a Saturday; 2026-10-11 a Sunday.
    expect(isBusinessDay(new Date("2026-10-05T12:00:00.000Z"))).toBe(true);
    expect(isBusinessDay(new Date("2026-10-06T12:00:00.000Z"))).toBe(true);
    expect(isBusinessDay(new Date("2026-10-10T12:00:00.000Z"))).toBe(false);
    expect(isBusinessDay(new Date("2026-10-11T12:00:00.000Z"))).toBe(false);
  });

  it("decides in Prague, not in UTC", () => {
    // Friday 22:00 UTC is already Saturday 00:00 in Prague.
    expect(isBusinessDay(new Date("2026-10-02T22:00:00.000Z"))).toBe(false);
    // Friday 20:00 UTC is still Friday 22:00 in Prague.
    expect(isBusinessDay(new Date("2026-10-02T20:00:00.000Z"))).toBe(true);
  });

  it("skips weekends: Friday + 2 business days is Tuesday", () => {
    const friday = new Date("2026-10-02T08:00:00.000Z");
    expect(addBusinessDays(friday, 2).toISOString()).toBe(
      "2026-10-06T08:00:00.000Z",
    );
  });

  it("Friday + 3 business days is Wednesday, + 4 is Thursday", () => {
    const friday = new Date("2026-10-02T08:00:00.000Z");
    expect(addBusinessDays(friday, 3).toISOString()).toBe(
      "2026-10-07T08:00:00.000Z",
    );
    expect(addBusinessDays(friday, 4).toISOString()).toBe(
      "2026-10-08T08:00:00.000Z",
    );
  });

  it("a weekend anchor starts counting on Monday", () => {
    const saturday = new Date("2026-10-03T10:00:00.000Z");
    expect(addBusinessDays(saturday, 1).toISOString()).toBe(
      "2026-10-05T10:00:00.000Z",
    );
    expect(addBusinessDays(saturday, 2).toISOString()).toBe(
      "2026-10-06T10:00:00.000Z",
    );
  });

  it("survives the Prague DST transition (CEST → CET, 2026-10-25)", () => {
    // Friday before the switch; the result must land on Tuesday —
    // the same calendar day a Prague wall clock would name.
    const friday = new Date("2026-10-23T08:00:00.000Z");
    expect(addBusinessDays(friday, 2).toISOString()).toBe(
      "2026-10-27T08:00:00.000Z",
    );
  });
});

describe("acceptance — Friday send with a 2/4 cadence (spec §20)", () => {
  const cadence = [2, 4];
  // Friday 10:00 Europe/Prague.
  const primarySent = new Date("2026-10-02T08:00:00.000Z");

  it("schedules follow-up #1 for Tuesday (+2 business days)", () => {
    expect(nextFollowUpDueAt(primarySent, 1, cadence)?.toISOString()).toBe(
      "2026-10-06T08:00:00.000Z",
    );
  });

  it("schedules follow-up #2 for Thursday (+4 business days)", () => {
    expect(nextFollowUpDueAt(primarySent, 2, cadence)?.toISOString()).toBe(
      "2026-10-08T08:00:00.000Z",
    );
  });

  it("measures follow-up #2 from follow-up #1's actual send, not the lead", () => {
    // Operator sends follow-up #1 on its due date (Tuesday).
    // +4 business days: Wed, Thu, Fri, Mon.
    const firstSent = new Date("2026-10-06T08:00:00.000Z");
    expect(nextFollowUpDueAt(firstSent, 2, cadence)?.toISOString()).toBe(
      "2026-10-12T08:00:00.000Z",
    );
  });
});

describe("parseFollowUpCadence", () => {
  it("parses a comma-separated list", () => {
    expect(parseFollowUpCadence("2,4,7")).toEqual([2, 4, 7]);
    expect(parseFollowUpCadence(" 2 , 4 ")).toEqual([2, 4]);
  });

  it("rejects empty, non-integer and non-positive values", () => {
    expect(parseFollowUpCadence("")).toBeNull();
    expect(parseFollowUpCadence("   ")).toBeNull();
    expect(parseFollowUpCadence("0,2")).toBeNull();
    expect(parseFollowUpCadence("-1,2")).toBeNull();
    expect(parseFollowUpCadence("2.5")).toBeNull();
    expect(parseFollowUpCadence("2,x")).toBeNull();
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
