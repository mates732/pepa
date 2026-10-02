import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chatIdFromUpdate,
  isAuthorizedChatId,
  isValidWebhookSecret,
  parseTelegramUpdate,
  TELEGRAM_SECRET_HEADER,
  type TelegramUpdate,
} from "./webhook-auth";

const SECRET = "whsec_please_change_me_0123456789";

beforeEach(() => {
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe("webhook secret header", () => {
  it("uses Telegram's documented header name", () => {
    expect(TELEGRAM_SECRET_HEADER).toBe("x-telegram-bot-api-secret-token");
  });

  it("accepts the exact secret", () => {
    expect(isValidWebhookSecret(SECRET, SECRET)).toBe(true);
  });

  it("rejects a wrong, partial or empty secret", () => {
    expect(isValidWebhookSecret("wrong", SECRET)).toBe(false);
    expect(isValidWebhookSecret(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(isValidWebhookSecret("", SECRET)).toBe(false);
    expect(isValidWebhookSecret(null, SECRET)).toBe(false);
    expect(isValidWebhookSecret(undefined, SECRET)).toBe(false);
  });

  it("fails closed when the server secret is not configured", () => {
    expect(isValidWebhookSecret(SECRET, null)).toBe(false);
    expect(isValidWebhookSecret(SECRET, "")).toBe(false);
  });
});

describe("parseTelegramUpdate", () => {
  it("parses a well-formed update", () => {
    const update = parseTelegramUpdate(
      JSON.stringify({ update_id: 1, message: { chat: { id: 5 }, text: "/start" } }),
    );
    expect(update?.message?.text).toBe("/start");
  });

  it("returns null instead of throwing on garbage", () => {
    expect(parseTelegramUpdate("not json")).toBeNull();
    expect(parseTelegramUpdate("[1,2,3]")).toBeNull();
    expect(parseTelegramUpdate('"a string"')).toBeNull();
    expect(parseTelegramUpdate("null")).toBeNull();
    expect(parseTelegramUpdate("")).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
  });
});

describe("chatIdFromUpdate", () => {
  it("reads the chat from a message", () => {
    expect(
      chatIdFromUpdate({ message: { chat: { id: -1001234567890 } } }),
    ).toBe("-1001234567890");
  });

  it("reads the chat from an edited message", () => {
    expect(chatIdFromUpdate({ edited_message: { chat: { id: 7 } } })).toBe("7");
  });

  it("reads the chat from a callback query", () => {
    expect(
      chatIdFromUpdate({ callback_query: { message: { chat: { id: 42 } } } }),
    ).toBe("42");
    expect(chatIdFromUpdate({ callback_query: { from: { id: 9 } } })).toBe("9");
  });

  it("returns null when there is no identifiable chat", () => {
    expect(chatIdFromUpdate({})).toBeNull();
    expect(chatIdFromUpdate({ message: {} })).toBeNull();
  });
});

describe("isAuthorizedChatId", () => {
  it("allows only the configured owner chat", () => {
    expect(isAuthorizedChatId("-1001234567890", "-1001234567890")).toBe(true);
  });

  it("rejects every other chat", () => {
    expect(isAuthorizedChatId("12345", "-1001234567890")).toBe(false);
    expect(isAuthorizedChatId("-1001234567891", "-1001234567890")).toBe(false);
    expect(isAuthorizedChatId("-100123456789", "-1001234567890")).toBe(false);
    expect(isAuthorizedChatId("admin", "-1001234567890")).toBe(false);
  });

  it("tolerates whitespace and numeric-vs-string differences", () => {
    expect(isAuthorizedChatId(" -1001234567890 ", "-1001234567890")).toBe(true);
    expect(isAuthorizedChatId(String(-1001234567890), "-1001234567890")).toBe(true);
  });

  it("rejects everything when no owner chat is configured", () => {
    expect(isAuthorizedChatId("-1001234567890", null)).toBe(false);
    expect(isAuthorizedChatId("-1001234567890", "")).toBe(false);
    expect(isAuthorizedChatId(null, "-1001234567890")).toBe(false);
  });
});

describe("unrelated updates", () => {
  it("parses but yields no chat for a poll update", () => {
    const update = parseTelegramUpdate(JSON.stringify({ update_id: 9, poll: { id: "x" } })) as TelegramUpdate;
    expect((update as unknown as { poll?: unknown }).poll).toBeDefined();
    expect(chatIdFromUpdate(update)).toBeNull();
  });
});