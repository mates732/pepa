import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatDateTime } from "@/lib/format";
import {
  formatFollowUpDueMessage,
  formatPlainNotification,
  formatStreakReminderNotification,
  followUpDueButtons,
  OPEN_IN_PEPA_LABEL,
  STREAK_REMINDER_TITLE,
  toActionNotification,
  toStreakReminderNotification,
} from "./format";

function titleAndBody(notification: { title: string; body: string }): [string, string] {
  return [notification.title, notification.body];
}

beforeEach(() => {
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
});

afterEach(() => {
  delete process.env.TELEGRAM_CHAT_ID;
});

const details = {
  leadName: "The Archive",
  email: "info@thearchive.cz",
  attempt: 1,
  lastContactedAt: "2026-09-30T09:00:00Z",
  dueAt: "2026-10-01T08:00:00Z",
  deepLink: "https://pepa.example.com/followup/fp1_abc",
};

describe("formatFollowUpDueMessage", () => {
  it("renders the notification surface exactly as designed", () => {
    // en-GB renders September as "Sept". The due line is built with the same
    // formatter the notification uses, so the pin is exact without assuming a
    // machine time zone.
    expect(formatFollowUpDueMessage(details)).toBe(
      [
        "🔥 FOLLOW-UP DUE",
        "",
        "The Archive",
        "",
        "Follow-up #1",
        `Due: ${formatDateTime(details.dueAt)}`,
        "Last contact: 30 Sept 2026",
        "",
        "info@thearchive.cz",
      ].join("\n"),
    );
  });

  it("includes the due time so overdue is distinguishable from just-due", () => {
    expect(formatFollowUpDueMessage(details)).toContain(`Due: ${formatDateTime(details.dueAt)}`);
  });

  it("falls back to an em dash when the due time is missing", () => {
    const text = formatFollowUpDueMessage({ ...details, dueAt: null });
    expect(text).toContain("Due: —");
  });

  it("falls back to the email when no company or contact name is known", () => {
    const text = formatFollowUpDueMessage({ ...details, leadName: null });
    expect(text.split("\n")[2]).toBe("info@thearchive.cz");
    expect(text).not.toContain("null");
  });

  it("shows an em dash when the lead has never been contacted", () => {
    const text = formatFollowUpDueMessage({ ...details, lastContactedAt: null });
    expect(text).toContain("Last contact: —");
  });

  it("does not depend on the machine locale for the missing-date case", () => {
    expect(formatFollowUpDueMessage({ ...details, lastContactedAt: null })).toContain("—");
  });

  it("never includes the subject or body", () => {
    const text = formatFollowUpDueMessage(details);
    expect(text).not.toContain("Re: AI reception");
    expect(text).not.toContain("Dobrý den");
  });

  it("renders plain text, so no Markdown/HTML can be injected via lead data", () => {
    const text = formatFollowUpDueMessage({
      ...details,
      leadName: "<b>bold</b> _markdown_",
    });
    expect(text).toContain("<b>bold</b>");
    expect(text).not.toContain("parse_mode");
  });
});

describe("toActionNotification", () => {
  it("splits the surface into a channel-agnostic title and body", () => {
    const notification = toActionNotification(details);

    expect(notification.title).toBe("🔥 FOLLOW-UP DUE");
    expect(notification.body).toContain("The Archive");
    expect(notification.body).toContain("Follow-up #1");
  });

  it("renders back to exactly the same message the provider sends today", () => {
    // The engine and the in-app trigger cannot drift apart.
    expect(formatPlainNotification(...titleAndBody(toActionNotification(details)))).toBe(
      formatFollowUpDueMessage(details),
    );
  });

  it("carries the deep link as an OPEN IN PEPA action", () => {
    const notification = toActionNotification(details);

    expect(notification.actionLabel).toBe(OPEN_IN_PEPA_LABEL);
    expect(notification.actionUrl).toBe(details.deepLink);
    expect(notification.actionUrl).not.toContain("thearchive");
  });

  it("never carries subject or body content", () => {
    const text = JSON.stringify(toActionNotification(details));
    expect(text).not.toContain("Re: AI reception");
    expect(text).not.toContain("Dobrý den");
  });
});

describe("followUpDueButtons", () => {
  it("produces a single OPEN IN PEPA URL button", () => {
    expect(followUpDueButtons(details)).toEqual([
      [{ text: OPEN_IN_PEPA_LABEL, url: details.deepLink }],
    ]);
  });

  it("puts only the opaque token in the URL", () => {
    const [row] = followUpDueButtons(details);
    expect(row[0].url).toContain("/followup/fp1_");
    expect(row[0].url).not.toContain("thearchive");
  });
});

/**
 * The 19:00 streak reminder. The message has to make the operator act before
 * midnight without claiming anything the data cannot support: it names the run
 * at risk and the deadline, and nothing else.
 */

const reminder = {
  streakDays: 5,
  appUrl: "https://pepa.example.com/",
};

describe("formatStreakReminderNotification", () => {
  it("renders the reminder surface exactly as designed", () => {
    expect(formatStreakReminderNotification(reminder)).toEqual({
      title: STREAK_REMINDER_TITLE,
      body: [
        "No outreach recorded as sent today.",
        "",
        "Yesterday kept a 5-day streak alive. It ends at midnight.",
        "",
        "Send one now to keep it.",
      ].join("\n"),
    });
  });

  it("uses the singular for a one-day streak", () => {
    const { body } = formatStreakReminderNotification({ ...reminder, streakDays: 1 });

    expect(body).toContain("Yesterday started a streak. It ends at midnight.");
    expect(body).toContain("Send one now to keep it.");
  });

  it("offers to start a run when nothing is at risk", () => {
    const { body } = formatStreakReminderNotification({ ...reminder, streakDays: 0 });

    expect(body).toContain("No streak is running right now.");
    expect(body).toContain("Send one now to start a new run.");
    expect(body).not.toContain("keep it");
  });

  it("never names a lead, subject or body", () => {
    const text = JSON.stringify(toStreakReminderNotification(reminder));

    expect(text).not.toContain("thearchive");
    expect(text).not.toContain("Re: AI reception");
    expect(text).not.toContain("Dobrý den");
  });
});

describe("toStreakReminderNotification", () => {
  it("carries the app URL as an OPEN IN PEPA action", () => {
    const notification = toStreakReminderNotification(reminder);

    expect(notification.title).toBe(STREAK_REMINDER_TITLE);
    expect(notification.actionLabel).toBe(OPEN_IN_PEPA_LABEL);
    expect(notification.actionUrl).toBe(reminder.appUrl);
  });

  it("renders back to exactly the same message the provider sends", () => {
    expect(formatPlainNotification(...titleAndBody(toStreakReminderNotification(reminder)))).toBe(
      formatStreakReminderNotification(reminder).title +
        "\n\n" +
        formatStreakReminderNotification(reminder).body,
    );
  });
});