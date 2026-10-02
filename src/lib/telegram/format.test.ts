import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatFollowUpDueMessage, followUpDueButtons, OPEN_IN_PEPA_LABEL } from "./format";

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