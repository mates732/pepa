import { describe, expect, it } from "vitest";

import { localDayKeyInZone } from "@/lib/outreach/stats-windows";

import { decideStreakReminder, STREAK_REMINDER_HOUR, type StreakReminderInput } from "./streak-reminder";

/**
 * The 19:00 rule, pinned.
 *
 * The reminder exists so an unbroken run of days with a recorded send is not
 * lost by accident. That makes the three halves of the rule the contract:
 * yesterday active, today inactive, and late enough in the local day.
 */

const PRAGUE = "Europe/Prague";

function input(overrides: Partial<StreakReminderInput> = {}): StreakReminderInput {
  return {
    // Tue 2026-10-13 and Mon 2026-10-12 had sends.
    dayKeys: ["2026-10-13", "2026-10-12"],
    todayKey: "2026-10-14",
    hour: 19,
    ...overrides,
  };
}

describe("decideStreakReminder — the run is at risk", () => {
  it("is due at 19:00 when yesterday had a send and today has none", () => {
    const decision = decideStreakReminder(input());

    expect(decision.due).toBe(true);
    expect(decision.atRisk).toBe(true);
    // Tue 13th + Mon 12th: the run ends yesterday, Monday the 11th has none.
    expect(decision.streakDays).toBe(2);
    expect(decision.dayKey).toBe("2026-10-14");
  });

  it("counts the streak the notification names — the run ending yesterday", () => {
    const decision = decideStreakReminder(
      input({ dayKeys: ["2026-10-13"] }),
    );

    expect(decision.due).toBe(true);
    expect(decision.streakDays).toBe(1);
  });

  it("stays silent before the deadline even when the run is at risk", () => {
    const decision = decideStreakReminder(input({ hour: STREAK_REMINDER_HOUR - 1 }));

    expect(decision.atRisk).toBe(true);
    expect(decision.due).toBe(false);
  });

  it("fires at exactly the deadline hour", () => {
    expect(decideStreakReminder(input({ hour: STREAK_REMINDER_HOUR })).due).toBe(true);
    expect(decideStreakReminder(input({ hour: STREAK_REMINDER_HOUR + 1 })).due).toBe(true);
  });

  it("stays silent once today has a send — one is all it takes", () => {
    const decision = decideStreakReminder(input({ dayKeys: ["2026-10-14", "2026-10-13"] }));

    expect(decision.atRisk).toBe(false);
    expect(decision.due).toBe(false);
    expect(decision.streakDays).toBe(0);
  });

  it("stays silent when yesterday had no send — nothing is at risk", () => {
    const decision = decideStreakReminder(input({ dayKeys: ["2026-10-11"] }));

    expect(decision.atRisk).toBe(false);
    expect(decision.due).toBe(false);
  });

  it("stays silent with no history at all", () => {
    const decision = decideStreakReminder(input({ dayKeys: [] }));

    expect(decision.atRisk).toBe(false);
    expect(decision.due).toBe(false);
  });

  it("counts a broken run honestly — a gap ends it at the gap", () => {
    // Saturday and Sunday were skipped; Monday's send is a new run.
    const decision = decideStreakReminder(
      input({ dayKeys: ["2026-10-13", "2026-10-09", "2026-10-08"] }),
    );

    expect(decision.streakDays).toBe(1);
  });

  it("accepts an overridden deadline hour", () => {
    expect(decideStreakReminder(input({ hour: 20, reminderHour: 21 })).due).toBe(false);
    expect(decideStreakReminder(input({ hour: 21, reminderHour: 21 })).due).toBe(true);
  });

  it("is silent on a malformed day key rather than guessing", () => {
    const decision = decideStreakReminder(input({ todayKey: "14.10.2026" }));

    expect(decision).toEqual({ due: false, atRisk: false, streakDays: 0, dayKey: "" });
  });

  it("is silent on an unusable hour", () => {
    expect(decideStreakReminder(input({ hour: Number.NaN })).due).toBe(false);
  });

  it("ignores malformed keys in the history", () => {
    const decision = decideStreakReminder(
      input({ dayKeys: ["2026-10-13", "not-a-day", ""] }),
    );

    expect(decision.streakDays).toBe(1);
  });
});

describe("decideStreakReminder — the zone decides the day, not the server", () => {
  it("uses the caller's calendar keys across a DST boundary", () => {
    // 2026-10-25 is the CEST→CET change in Prague. 17:30 UTC is already 18:30
    // local that evening; the day key still belongs to Sunday the 25th.
    const instant = new Date("2026-10-25T17:30:00.000Z");
    const todayKey = localDayKeyInZone(PRAGUE, instant)!;
    expect(todayKey).toBe("2026-10-25");

    const decision = decideStreakReminder({
      dayKeys: ["2026-10-24"],
      todayKey,
      hour: 19,
    });

    // Saturday the 24th had a send; Sunday the 25th is running out.
    expect(decision.atRisk).toBe(true);
    expect(decision.due).toBe(true);
  });
});
