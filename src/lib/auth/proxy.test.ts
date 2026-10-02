import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { proxy } from "../../proxy";
import { createSessionToken, SESSION_COOKIE } from "./token";

const SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

function request(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
  return new NextRequest(new URL(`https://pepa.internal${path}`), { headers });
}

beforeEach(() => {
  process.env.PEPA_SESSION_SECRET = SECRET;
});

describe("proxy", () => {
  it("redirects an unauthenticated request to /login", () => {
    const response = proxy(request("/"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://pepa.internal/login");
  });

  it("preserves the original destination for same-origin paths", () => {
    const response = proxy(request("/leads/42"));
    expect(response.headers.get("location")).toBe("https://pepa.internal/login?next=%2Fleads%2F42");
  });

  it("lets /login through for anonymous visitors", () => {
    const response = proxy(request("/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("bounces an authenticated visitor away from /login", () => {
    const response = proxy(request("/login", createSessionToken()));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://pepa.internal/");
  });

  it("allows an authenticated request to a protected route", () => {
    const response = proxy(request("/", createSessionToken()));
    expect(response.status).toBe(200);
  });

  it("rejects a forged cookie", () => {
    const response = proxy(request("/", "v1.forged.signature"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://pepa.internal/login");
  });

  it("rejects an expired cookie", () => {
    const token = createSessionToken(Date.now() - 60 * 60 * 24 * 40 * 1000);
    const response = proxy(request("/", token));
    expect(response.status).toBe(307);
  });

  it("renews a session that is past half its life", () => {
    const token = createSessionToken(Date.now() - 60 * 60 * 24 * 20 * 1000);
    const response = proxy(request("/", token));
    expect(response.status).toBe(200);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBeTruthy();
  });

  it("leaves a fresh session cookie untouched", () => {
    const token = createSessionToken();
    const response = proxy(request("/", token));
    expect(response.status).toBe(200);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBeUndefined();
  });
});