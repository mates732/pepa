import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FollowUpPage from "./page";

/**
 * Phase 8B: where a Telegram notification link lands.
 *
 * The security-relevant claim of this phase is that the redirect carries the
 * SAME opaque token and nothing else. If it ever carried a message id, a leaked
 * URL would become a direct reference to a row; if it carried a lead id or a
 * recipient, Telegram history would leak outreach data. Both are asserted below.
 *
 * `redirect()` is mocked to record its target rather than throw, so the routing
 * decision can be inspected directly. Everything the page would reach the
 * database for is mocked, which also lets the suite assert that rendering the
 * page writes nothing.
 */

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const FOLLOW_UP_ID = "55555555-5555-5555-5555-555555555555";
const INITIAL_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN = "fp1_testtokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const { redirectTo, resolved, db } = vi.hoisted(() => ({
  redirectTo: [] as string[],
  resolved: {
    value: null as null | { ok: boolean; error: string | null; data: unknown },
    calls: [] as Array<{ token: string; purpose: string }>,
  },
  /** Mutable counter: any real database access increments it. */
  db: { touched: 0 },
}));

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    redirectTo.push(target);
  },
}));

vi.mock("@/lib/auth/dal", () => ({
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/config/base-url", () => ({
  buildDeepLink: async (token: string) => `https://pepa.example.com/followup/${token}`,
  buildFollowUpWorkspaceDeepLink: async (token: string) => `https://pepa.example.com/?followup=${token}`,
}));

vi.mock("@/lib/providers/notifications", () => ({}));
vi.mock("@/lib/providers/registry", () => ({
  getNotificationService: () => ({ id: "telegram" }),
}));

vi.mock("@/components/follow-up-editor", () => ({
  FollowUpEditor: () => null,
}));

vi.mock("@/lib/services/action-token-service", () => ({
  INVALID_TOKEN_MESSAGE: "This link is invalid or has expired.",
  resolveActionToken: async (token: string, purpose: string) => {
    resolved.calls.push({ token, purpose });
    return resolved.value;
  },
}));

// Any real database access would land here. Rendering must not cause one.
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => {
    db.touched += 1;
    throw new Error("the deep-link page must not open its own database client");
  },
}));

/** A stored message, shaped as `resolveActionToken` returns it. */
function storedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: FOLLOW_UP_ID,
    lead_id: LEAD_ID,
    recipient_email: "info@thearchive.cz",
    subject: "Re: AI recepce",
    body: "Navazuji",
    status: "draft",
    provider: null,
    provider_message_id: null,
    sent_at: null,
    created_at: "2026-09-29T00:00:00.000Z",
    sequence_number: 1,
    parent_message_id: INITIAL_ID,
    ...overrides,
  };
}

function lead() {
  return {
    id: LEAD_ID,
    email: "info@thearchive.cz",
    company_name: "The Archive",
    contact_name: null,
    status: "follow_up",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
    last_contacted_at: "2026-09-28T00:00:00.000Z",
    next_followup_at: "2026-10-01T08:00:00.000Z",
    followup_count: 0,
  };
}

function resolves(outreach: Record<string, unknown> | null) {
  resolved.value = {
    ok: true,
    error: null,
    data: { lead: lead(), outreach, expiresAt: "2026-10-05T00:00:00.000Z" },
  };
}

async function renderPage(token = TOKEN) {
  return renderToStaticMarkup(
    await FollowUpPage({ params: Promise.resolve({ token }) } as never),
  );
}

beforeEach(() => {
  redirectTo.length = 0;
  resolved.calls = [];
  db.touched = 0;
  resolved.value = null;
});

describe("Phase 8B — a notification token lands on the Phase 4C detail", () => {
  it("redirects a real follow-up to the dashboard with the token and nothing else", async () => {
    resolves(storedMessage());

    await renderPage();

    expect(redirectTo).toEqual([`https://pepa.example.com/?followup=${TOKEN}`]);
  });

  it("puts no message id, lead id, recipient or subject in the redirect target", async () => {
    resolves(storedMessage());

    await renderPage();

    const [target] = redirectTo;
    expect(target).not.toContain(FOLLOW_UP_ID);
    expect(target).not.toContain(INITIAL_ID);
    expect(target).not.toContain(LEAD_ID);
    expect(target).not.toContain("info@thearchive.cz");
    expect(target).not.toContain("Re: AI recepce");
    expect(target).not.toContain("Navazuji");
  });

  it("resolves the token server-side, for the follow-up purpose only", async () => {
    resolves(storedMessage());

    await renderPage();

    // The identity comes from the token's own digest, never from the URL.
    expect(resolved.calls).toEqual([{ token: TOKEN, purpose: "followup_composer" }]);
  });

  it("writes nothing: rendering opens no database client of its own", async () => {
    resolves(storedMessage());

    await renderPage();

    // Selecting a follow-up is not sending: no status, no sent_at, no counter,
    // no schedule, no notification row, no Gmail.
    expect(db.touched).toBe(0);
  });

  it("follows the exact follow-up it was minted for, not the newest one", async () => {
    // The token names one row. Nothing re-derives "the current follow-up".
    resolves(storedMessage({ id: FOLLOW_UP_ID, sequence_number: 2 }));

    await renderPage();

    const [target] = redirectTo;
    expect(target).toContain(TOKEN);
    expect(target).not.toContain("sequence");
    expect(resolved.calls).toHaveLength(1);
  });
});

describe("Phase 8B — tokens that must not redirect", () => {
  it("keeps the composer for a token with no message at all", async () => {
    resolves(null);

    const markup = await renderPage();

    expect(redirectTo).toEqual([]);
    expect(markup).toContain("PEPA the Outman");
  });

  it("keeps the composer for a token anchored on an initial outreach", async () => {
    // Slot 0 is not a follow-up; the composer is what that token is for.
    resolves(storedMessage({ id: INITIAL_ID, sequence_number: 0, parent_message_id: null }));

    const markup = await renderPage();

    expect(redirectTo).toEqual([]);
    expect(markup).toContain("PEPA the Outman");
  });

  it("shows the existing error for an invalid or tampered token", async () => {
    resolved.value = {
      ok: false,
      error: "This link is invalid or has expired.",
      data: null,
    };

    const markup = await renderPage("fp1_tampered");

    expect(redirectTo).toEqual([]);
    expect(markup).toContain("This link is invalid or has expired.");
    expect(db.touched).toBe(0);
  });

  it("shows the existing error for an expired token", async () => {
    // Expiry is decided inside `resolveActionToken`, which returns the same
    // indistinguishable failure as any other bad token.
    resolved.value = { ok: false, error: "This link is invalid or has expired.", data: null };

    const markup = await renderPage();

    expect(redirectTo).toEqual([]);
    expect(markup).toContain("This link is invalid or has expired.");
  });

  it("gives the same error whatever the reason, so nothing can be probed", async () => {
    const reasons = [
      { ok: false, error: "This link is invalid or has expired.", data: null },
      { ok: false, error: "This link is invalid or has expired.", data: null },
      { ok: false, error: null, data: null },
    ];

    const rendered: string[] = [];
    for (const value of reasons) {
      resolved.value = value;
      rendered.push(await renderPage());
      redirectTo.length = 0;
    }

    expect(new Set(rendered).size).toBe(1);
  });

  it("never redirects an already-sent follow-up to some other message", async () => {
    // A sent row is still a real row, so it still redirects — but only to itself,
    // by token. There is no fallback that could substitute a different message.
    resolves(storedMessage({ status: "sent", sent_at: "2026-10-01T09:00:00.000Z" }));

    await renderPage();

    expect(redirectTo).toEqual([`https://pepa.example.com/?followup=${TOKEN}`]);
    expect(redirectTo[0]).not.toContain("outreach");
  });
});
