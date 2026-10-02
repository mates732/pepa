import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAuthorizedChat, TelegramProvider } from "./telegram";
import type { Lead } from "@/lib/types";

/**
 * Exercises the provider against a mocked Telegram HTTP API: payload shape,
 * the single OPEN IN PEPA button, and — most importantly — that the bot token
 * is only ever used as a URL path segment and never leaks into a message.
 */

const BOT_TOKEN = "999999:NOT_A_REAL_TOKEN_FOR_TESTS";
const OWNER_CHAT = "-1001234567890";

const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

vi.mock("@/lib/telegram/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/client")>();
  return { ...actual };
});

vi.mock("@/lib/services/action-token-service", () => ({
  createFollowUpToken: async () => ({
    ok: true,
    error: null,
    data: { token: "fp1_testtoken", expiresAt: "2026-10-05T00:00:00.000Z" },
  }),
}));

vi.mock("@/lib/config/base-url", () => ({
  buildDeepLink: async (token: string) => `https://pepa.example.com/followup/${token}`,
  getBaseUrl: async () => "https://pepa.example.com",
}));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: async () => ({ id: "owner", since: 0 }),
}));

const LEAD: Lead = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "info@thearchive.cz",
  company_name: "The Archive",
  contact_name: null,
  status: "follow_up",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
  last_contacted_at: "2026-09-30T00:00:00Z",
  next_followup_at: "2026-10-07T00:00:00Z",
  followup_count: 1,
};

function mockFetch(ok = true, description?: string) {
  requests.length = 0;
  return vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return {
      ok,
      status: ok ? 200 : 401,
      json: async () =>
        ok
          ? { ok: true, result: { message_id: 555 } }
          : { ok: false, description },
    };
  });
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID = OWNER_CHAT;
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  vi.unstubAllGlobals();
});

describe("TelegramProvider", () => {
  it("reports configuration state", () => {
    const provider = new TelegramProvider();
    expect(provider.id).toBe("telegram");
    expect(provider.isConfigured()).toBe(true);

    delete process.env.TELEGRAM_BOT_ID;
    delete process.env.TELEGRAM_CHAT_ID;
    expect(provider.isConfigured()).toBe(false);
  });

  it("sends the follow-up notification with exactly one deep-link button", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TelegramProvider().sendFollowUpDue({ lead: LEAD, attempt: 2 });

    expect(result).toMatchObject({ provider: "telegram", providerMessageId: "555" });

    expect(requests).toHaveLength(1);
    const [request] = requests;

    // Chat, not user id; the owner chat only.
    expect(request.body.chat_id).toBe(OWNER_CHAT);
    expect(String(request.body.text)).toContain("🔥 FOLLOW-UP DUE");
    expect(String(request.body.text)).toContain("The Archive");
    expect(String(request.body.text)).toContain("Follow-up #2");
    expect(String(request.body.text)).not.toContain("Re: ");

    expect(request.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "OPEN IN PEPA", url: "https://pepa.example.com/followup/fp1_testtoken" }],
      ],
    });

    // No callback_data: nothing about the lead travels inside Telegram.
    expect(JSON.stringify(request.body)).not.toContain("callback_data");
  });

  it("uses the token only in the URL path and never in the message", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    await new TelegramProvider().sendFollowUpDue({ lead: LEAD, attempt: 2 });

    const [request] = requests;
    expect(request.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(String(request.body.text)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(request.body)).not.toContain(BOT_TOKEN);
    // chat_id necessarily rides the API payload; what must never travel is the
    // owner's chat id inside the message text or button URL.
    expect(String(request.body.text)).not.toContain(OWNER_CHAT);
    expect(JSON.stringify(request.body.reply_markup)).not.toContain(OWNER_CHAT);
  });

  it("throws a scrubbed error and never echoes the token on API failure", async () => {
    const fetchMock = mockFetch(false, `Unauthorized: bot${BOT_TOKEN} is blocked`);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new TelegramProvider().sendFollowUpDue({ lead: LEAD, attempt: 1 }),
    ).rejects.toThrow(/bot<redacted>/);

    await expect(
      new TelegramProvider().sendFollowUpDue({ lead: LEAD, attempt: 1 }),
    ).rejects.not.toThrow(BOT_TOKEN);
  });

  it("refuses to send when Telegram is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(
      new TelegramProvider().sendFollowUpDue({ lead: LEAD, attempt: 1 }),
    ).rejects.toThrow(/not configured/i);
  });

  it("renders an ActionNotification as one inline OPEN IN PEPA button", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    await new TelegramProvider().sendActionNotification({
      title: "🔥 FOLLOW-UP DUE",
      body: "The Archive\n\nFollow-up #1",
      actionLabel: "OPEN IN PEPA",
      actionUrl: "https://pepa.example.com/followup/fp1_abc",
    });

    const request = requests[0];
    expect(request.body.chat_id).toBe(OWNER_CHAT);
    expect(String(request.body.text)).toBe("🔥 FOLLOW-UP DUE\n\nThe Archive\n\nFollow-up #1");
    expect(request.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "OPEN IN PEPA", url: "https://pepa.example.com/followup/fp1_abc" }],
      ],
    });
  });

  it("throws when the channel rejects an action notification", async () => {
    vi.stubGlobal("fetch", mockFetch(false, "Bad Request: chat not found"));

    await expect(
      new TelegramProvider().sendActionNotification({
        title: "🔥 FOLLOW-UP DUE",
        body: "The Archive",
        actionLabel: "OPEN IN PEPA",
        actionUrl: "https://pepa.example.com/followup/fp1_abc",
      }),
    ).rejects.toThrow(/telegram delivery failed/i);
  });

  it("refuses to render an action notification when unconfigured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new TelegramProvider().sendActionNotification({
        title: "x",
        body: "y",
        actionLabel: "OPEN IN PEPA",
        actionUrl: "https://pepa.example.com/followup/fp1_abc",
      }),
    ).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("implements the generic NotificationService.send contract", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    await new TelegramProvider().send({ title: "PEPA", body: "3 follow-ups are due today." });

    expect(String(requests[0].body.text)).toBe("PEPA\n\n3 follow-ups are due today.");
    expect(requests[0].body.reply_markup).toBeUndefined();
  });
});

describe("isAuthorizedChat", () => {
  it("matches only the configured chat", () => {
    expect(isAuthorizedChat(OWNER_CHAT)).toBe(true);
    expect(isAuthorizedChat(` ${OWNER_CHAT} `)).toBe(true);
    expect(isAuthorizedChat(424242)).toBe(false);
    expect(isAuthorizedChat(null)).toBe(false);
    expect(isAuthorizedChat("")).toBe(false);
  });

  it("denies everyone when no chat is configured", () => {
    delete process.env.TELEGRAM_CHAT_ID;
    expect(isAuthorizedChat(OWNER_CHAT)).toBe(false);
  });
});