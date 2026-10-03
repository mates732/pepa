import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OutreachStats } from "@/components/outreach-stats";

/**
 * Stats card tests.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component test, so
 * no new UI framework or DOM environment is introduced.
 *
 * The properties pinned here are the ones a visual change would break: the real
 * numbers render, the zero state is a genuine zero rather than a placeholder,
 * the breakdown labels are present, and no control exists that could act on
 * recorded outreach.
 */

function render(overrides: Partial<React.ComponentProps<typeof OutreachStats>> = {}) {
  const props: React.ComponentProps<typeof OutreachStats> = {
    stats: {
      today: 6,
      week: 31,
      month: 87,
      allTime: 243,
      initialOutreach: 42,
      followUps: 201,
      totalSent: 243,
    },
    loading: false,
    error: null,
    complete: true,
    timeZone: "Europe/Prague",
    ...overrides,
  };

  return renderToStaticMarkup(<OutreachStats {...props} />);
}

/** Strip tags so assertions read against text, not markup. */
function textOf(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("OutreachStats values", () => {
  it("renders every figure", () => {
    const text = textOf(render());

    expect(text).toContain("Today");
    expect(text).toContain("This week");
    expect(text).toContain("This month");
    expect(text).toContain("All time");
    expect(text).toContain("6");
    expect(text).toContain("31");
    expect(text).toContain("87");
    expect(text).toContain("243");
  });

  it("renders the breakdown", () => {
    const text = textOf(render());

    expect(text).toContain("Initial outreach");
    expect(text).toContain("Follow-ups");
    expect(text).toContain("Total sent");
    expect(text).toContain("42");
    expect(text).toContain("201");
  });

  it("states the zone the day and week were counted in", () => {
    expect(textOf(render())).toContain("Europe/Prague");
  });
});

describe("OutreachStats zero state", () => {
  it("shows real zeroes and no sample values", () => {
    const text = textOf(
      render({
        stats: {
          today: 0,
          week: 0,
          month: 0,
          allTime: 0,
          initialOutreach: 0,
          followUps: 0,
          totalSent: 0,
        },
      }),
    );

    expect(text).toContain("No outreach recorded as sent yet");
    // Nothing that could read as a placeholder measurement.
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/\bN\/A\b/);
  });

  it("falls back to zeroes before any load has resolved", () => {
    const text = textOf(render({ stats: null }));

    expect(text).toContain("Outreach stats");
    expect(text).toContain("No outreach recorded as sent yet");
  });

  it("says nothing about drafts while the count is zero", () => {
    const markup = render({
      stats: {
        today: 0,
        week: 0,
        month: 0,
        allTime: 0,
        initialOutreach: 0,
        followUps: 0,
        totalSent: 0,
      },
    });

    // Drafts and unsent follow-ups are excluded by design; the card has to say
    // so rather than implying no outreach exists at all.
    expect(markup).toContain("Drafts and unsent follow-ups are not counted");
  });
});

describe("OutreachStats is analytical only", () => {
  it("contains no control that could change recorded outreach", () => {
    const markup = render();

    expect(markup).not.toMatch(/mark as sent/i);
    expect(markup).not.toMatch(/mark unsent/i);
    expect(markup).not.toMatch(/open in gmail/i);
    expect(markup).not.toMatch(/delete/i);
    expect(markup).not.toMatch(/edit/i);
    expect(markup).not.toMatch(/retry/i);
  });

  it("offers no streak, milestone or gamification framing", () => {
    const markup = render();

    expect(markup).not.toMatch(/streak/i);
    expect(markup).not.toMatch(/milestone/i);
    expect(markup).not.toMatch(/achievement/i);
    expect(markup).not.toMatch(/\bXP\b/);
    expect(markup).not.toMatch(/points/i);
  });

  it("admits a capped scan rather than presenting it as the full total", () => {
    const text = textOf(render({ complete: false }));

    expect(text).toContain("most recent stored sends only");
  });

  it("shows a load error instead of zeroes", () => {
    const text = textOf(render({ error: "Stats could not be loaded." }));

    expect(text).toContain("Stats could not be loaded.");
    // A failed read must not read as "nothing has been sent".
    expect(text).not.toContain("No outreach recorded as sent yet");
  });
});