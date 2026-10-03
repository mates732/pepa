import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OutreachStreaks } from "@/components/outreach-streaks";

/**
 * Streaks card tests.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component test, so
 * no new UI framework or DOM environment is introduced.
 *
 * The properties pinned here are the ones a visual change would break: the real
 * figures render, the zero state is a genuine zero, a capped history is admitted
 * instead of hidden, and the card contains no gamification vocabulary and no
 * control that could act on recorded outreach.
 */

function render(overrides: Partial<React.ComponentProps<typeof OutreachStreaks>> = {}) {
  const props: React.ComponentProps<typeof OutreachStreaks> = {
    streaks: {
      currentStreak: 7,
      longestStreak: 12,
      activeDaysThisWeek: 5,
      activeDaysThisMonth: 18,
      totalActiveDays: 61,
      daysInWeek: 7,
      daysInMonth: 31,
    },
    loading: false,
    error: null,
    complete: true,
    currentStreakComplete: true,
    timeZone: "Europe/Prague",
    ...overrides,
  };

  return renderToStaticMarkup(<OutreachStreaks {...props} />);
}

/** Strip tags so assertions read against text, not markup. */
function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("OutreachStreaks values", () => {
  it("renders every figure with factual labels", () => {
    const text = textOf(render());

    expect(text).toContain("Current streak");
    expect(text).toContain("Longest streak");
    expect(text).toContain("Active days this week");
    expect(text).toContain("Active days this month");
    expect(text).toContain("7 days");
    expect(text).toContain("12 days");
    expect(text).toContain("5 / 7");
    expect(text).toContain("18 / 31");
  });

  it("uses the denominator the server resolved for the month", () => {
    const text = textOf(
      render({
        streaks: {
          currentStreak: 1,
          longestStreak: 1,
          activeDaysThisWeek: 1,
          activeDaysThisMonth: 19,
          totalActiveDays: 19,
          daysInWeek: 7,
          daysInMonth: 30,
        },
      }),
    );

    expect(text).toContain("19 / 30");
  });

  it("states the zone the days were resolved in", () => {
    expect(textOf(render())).toContain("Europe/Prague");
  });

  it("says where the figures come from", () => {
    expect(textOf(render())).toContain("Consecutive calendar days with a recorded send");
  });
});

describe("OutreachStreaks zero state", () => {
  it("shows real zeroes and no sample values", () => {
    const text = textOf(
      render({
        streaks: {
          currentStreak: 0,
          longestStreak: 0,
          activeDaysThisWeek: 0,
          activeDaysThisMonth: 0,
          totalActiveDays: 0,
          daysInWeek: 7,
          daysInMonth: 31,
        },
      }),
    );

    expect(text).toContain("No active days yet.");
    expect(text).toContain("0 days");
    expect(text).toContain("0 / 7");
    expect(text).toContain("0 / 31");
    expect(text).not.toMatch(/\b12\b/);
  });

  it("shows zeros before the first load rather than a placeholder", () => {
    const text = textOf(render({ streaks: null, loading: true }));

    expect(text).toContain("Loading");
    expect(text).toContain("0 / 7");
    expect(text).toContain("0 days");
  });

  it("reports a one-day streak in the singular", () => {
    const text = textOf(
      render({
        streaks: {
          currentStreak: 1,
          longestStreak: 1,
          activeDaysThisWeek: 1,
          activeDaysThisMonth: 1,
          totalActiveDays: 1,
          daysInWeek: 7,
          daysInMonth: 31,
        },
      }),
    );

    expect(text).toContain("1 day");
    expect(text).toContain("1 active day");
  });
});

describe("OutreachStreaks completeness", () => {
  it("admits a capped history beside the longest streak", () => {
    const text = textOf(render({ complete: false, currentStreakComplete: true }));

    expect(text).toContain("Based on available history");
    expect(text).toContain("capped");
    expect(text).toContain("may be longer");
  });

  it("keeps an exact current streak unqualified while the history is capped", () => {
    const text = textOf(render({ complete: false, currentStreakComplete: true }));

    expect(text).not.toContain("May be understated");
  });

  it("says when the current streak itself may be understated", () => {
    const text = textOf(render({ complete: false, currentStreakComplete: false }));

    expect(text).toContain("May be understated");
    expect(text).toContain("understated");
  });

  it("claims nothing about limits when the scan was complete", () => {
    const text = textOf(render());

    expect(text).not.toContain("Based on available history");
    expect(text).not.toContain("May be understated");
  });

  it("surfaces the error instead of figures", () => {
    const text = textOf(render({ error: "Streaks could not be loaded." }));

    expect(text).toContain("Streaks could not be loaded.");
    expect(text).not.toContain("Current streak");
  });
});

describe("OutreachStreaks is analytical only", () => {
  it("renders no control that could act on recorded outreach", () => {
    const markup = render();

    expect(markup).not.toMatch(/<button/);
    expect(markup).not.toMatch(/<input/);
    expect(markup).not.toMatch(/<form/);
  });

  it("contains no gamification vocabulary", () => {
    const text = textOf(render({ complete: false }));

    // No flames, encouragement, rewards, XP or milestone framing: every one of
    // them is a claim this data cannot make.
    expect(text).not.toMatch(/🔥|fire/i);
    expect(text).not.toMatch(/\bXP\b|\bpoints?\b|\bbadges?\b|\bachievements?\b/i);
    expect(text).not.toMatch(/\blevels?\b|\brewards?\b|\bfreeze\b|milestone/i);
    expect(text).not.toMatch(/keep going|don'?t break|amazing|congratul/i);
  });

  it("renders as a single section, inside the existing dashboard stack", () => {
    expect(render().match(/<section/g)).toHaveLength(1);
  });
});