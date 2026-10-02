import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answerMock = vi.fn(async () => true);

vi.mock("@/lib/telegram/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/client")>();
  return { ...actual, answerCallbackQuery: answerMock };
});

const SECRET = "whsec_please_change_me_0123456789";
const OWNER_CHAT = -1001234567890;

async function post(
  body: unknown,
  { secret, chat = OWNER_CHAT, updateType = "message" }: { secret?: string | null; chat?: number; updateType?: string },
) {
  const payload =
    updateType === "callback"
      ? { update_id: 1, callback_query: { id: "cb1", data: "noop", message: { chat: { id: chat } } } }
      : { update_id: 1, [updateType]: { chat: { id: chat }, text: "/start" } };

  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret !== null) headers.set("x-telegram-bot-api-secret-token", secret ?? SECRET);

  const { POST } = await import("./route");
  return POST(new NextRequest("https://pepa.example.com/api/telegram/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }));
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123456:TEST_TOKEN_VALUE_NOT_REAL";
  process.env.TELEGRAM_CHAT_ID = String(OWNER_CHAT);
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  answerMock.mockClear();
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe("POST /api/telegram/webhook", () => {
  it("answers 200 for a correctly signed owner delivery", async () => {
    const response = await post({}, {});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a request with no secret header (indistinguishable from success)", async () => {
    const response = await post({}, { secret: null });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a wrong secret", async () => {
    const response = await post({}, { secret: "wrong-secret" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("fails closed when no webhook secret is configured", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const response = await post({}, {});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("ignores an unknown chat without revealing it is unauthorized", async () => {
    const response = await post({}, { chat: 424242 });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("acknowledges a callback from the owner and nothing else", async () => {
    const response = await post({}, { updateType: "callback" });
    expect(response.status).toBe(200);
    expect(answerMock).toHaveBeenCalledWith("cb1");
  });

  it("does not answer a callback from an unknown chat", async () => {
    const response = await post({}, { updateType: "callback", chat: 999 });
    expect(response.status).toBe(200);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it("ignores an unrelated update type", async () => {
    const response = await post({}, { updateType: "poll" });
    expect(response.status).toBe(200);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it("never echoes the bot token, chat id or webhook secret", async () => {
    const response = await post({}, {});
    const text = JSON.stringify(await response.clone().json()) + JSON.stringify([...response.headers]);
    expect(text).not.toContain("123456:TEST_TOKEN_VALUE_NOT_REAL");
    expect(text).not.toContain(String(OWNER_CHAT));
    expect(text).not.toContain(SECRET);
  });

  it("handles a malformed body without throwing", async () => {
    const { POST } = await import("./route");
    const request = new NextRequest("https://pepa.example.com/api/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET, "Content-Type": "application/json" },
      body: "{not json",
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
  });
});