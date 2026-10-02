import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatFollowUpDueMessage,
  formatPlainNotification,
  followUpDueButtons,
  OPEN_IN_PEPA_LABEL,
  toActionNotification,
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
  deepLink: "https://pepa.example.com/followup/fp1_abc",
};

describe("formatFollowUpDueMessage", () => {
  it("renders the notification surface exactly as designed", () => {
    // en-GB renders September as "Sept".
    expect(formatFollowUpDueMessage(details)).toBe(
      [
        "🔥 FOLLOW-UP DUE",
        "",
        "The Archive",
        "",
        "Follow-up #1",
        "Last contact: 30 Sept 2026",
        "",
        "info@thearchive.cz",
      ].join("\n"),
    );
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