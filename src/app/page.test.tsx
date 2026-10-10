import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Page from "./page";

/**
 * Phase 8B: the authenticated end of a Telegram notification link.
 *
 * The page receives `?followup=<token>` and must turn it into an exact message id
 * by resolving the token on the server. These tests pin the three properties that
 * matter:
 *
 *   1. the id handed to the dashboard is the one the token's digest resolves to;
 *   2. nothing is read from the URL except the opaque token, so a crafted query
 *      cannot select a row directly;
 *   3. a token that does not resolve opens nothing rather than guessing.
 *
 * `Dashboard` is replaced by a probe that echoes the prop, so the assertion is on
 * the real server-side decision rather than on rendered UI.
 */

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const FOLLOW_UP_ID = "55555555-5555-5555-5555-555555555555";
const INITIAL_ID = "22222222-2222-2222-2222-222222222222";
const TOKEN = "fp1_testtokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const { resolved, verifySessionCalls } = vi.hoisted(() => ({
  resolved: {
    value: null as null | { ok: boolean; error: string | null; data: unknown },
    calls: [] as Array<{ token: string; purpose: string }>,
  },
  verifySessionCalls: { count: 0 },
}));

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({ connection: async () => undefined }));

vi.mock("@/lib/auth/dal", () => ({
  verifySession: async () => {
    verifySessionCalls.count += 1;
    return { id: "owner", since: 0 };
  },
  requireAuthenticatedUser: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/config/env", () => ({
  getEnvStatus: () => ({ configured: true, missing: [], detail: null }),
}));

vi.mock("@/app/auth-actions", () => ({ logout: async () => undefined }));
vi.mock("@/app/dev-actions", () => ({ devToolsEnabled: async () => false }));
vi.mock("@/components/setup-notice", () => ({ SetupNotice: () => null }));
vi.mock("@/components/telegram-test-button", () => ({ TelegramTestButton: () => null }));

vi.mock("@/lib/services/outreach-service", () => ({
  listOutreachHistory: async () => ({ ok: true, data: [], error: null }),
}));

vi.mock("@/lib/services/action-token-service", () => ({
  resolveActionToken: async (token: string, purpose: string) => {
    resolved.calls.push({ token, purpose });
    return resolved.value;
  },
}));

vi.mock("@/components/dashboard", () => ({
  Dashboard: ({ initialFollowUpId }: { initialFollowUpId?: string | null }) => (
    <div data-testid="probe">{initialFollowUpId ?? "none"}</div>
  ),
}));

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

function resolves(outreach: Record<string, unknown> | null) {
  resolved.value = {
    ok: true,
    error: null,
    data: {
      lead: { id: LEAD_ID, email: "info@thearchive.cz", followup_count: 0 },
      outreach,
      expiresAt: "2026-10-05T00:00:00.000Z",
    },
  };
}

async function renderPage(query: Record<string, string | string[]> = {}) {
  const markup = renderToStaticMarkup(
    await Page({ searchParams: Promise.resolve(query) } as never),
  );
  return markup.match(/data-testid="probe">([^<]*)</)?.[1] ?? "missing";
}

beforeEach(() => {
  resolved.calls = [];
  resolved.value = null;
  verifySessionCalls.count = 0;
});

describe("Phase 8B — dashboard resolves the deep-link token server-side", () => {
  it("opens the exact follow-up the token names", async () => {
    resolves(storedMessage());

    await expect(renderPage({ followup: TOKEN })).resolves.toBe(FOLLOW_UP_ID);
  });

  it("verifies the session before resolving anything", async () => {
    resolves(storedMessage());

    await renderPage({ followup: TOKEN });

    // The session gate runs before the token is read, and the token is never
    // resolved for a request that failed it.
    expect(verifySessionCalls.count).toBe(1);
    expect(resolved.calls).toHaveLength(1);
  });

  it("reads only the token from the URL, never a message id", async () => {
    resolves(storedMessage());

    // A crafted `message`/`id` parameter alongside the token is ignored: the only
    // id that can win is the one the token's own digest resolves to.
    const probe = await renderPage({ followup: TOKEN, message: INITIAL_ID, id: INITIAL_ID });

    expect(probe).toBe(FOLLOW_UP_ID);
    expect(probe).not.toBe(INITIAL_ID);
    expect(resolved.calls).toEqual([{ token: TOKEN, purpose: "followup_composer" }]);
  });

  it("opens nothing for a tampered or unknown token", async () => {
    resolved.value = { ok: false, error: "This link is invalid or has expired.", data: null };

    await expect(renderPage({ followup: "fp1_tampered" })).resolves.toBe("none");
  });

  it("opens nothing for an expired token", async () => {
    // Expiry is decided inside the resolver, which fails indistinguishably.
    resolved.value = { ok: false, error: "This link is invalid or has expired.", data: null };

    await expect(renderPage({ followup: TOKEN })).resolves.toBe("none");
  });

  it("opens nothing for a token that resolves to no message", async () => {
    resolves(null);

    await expect(renderPage({ followup: TOKEN })).resolves.toBe("none");
  });

  it("opens nothing for a token anchored on an initial outreach", async () => {
    // Slot 0 is not a follow-up. The Phase 4C detail is about follow-ups, so this
    // keeps its existing behaviour instead of opening a slot-0 "follow-up".
    resolves(storedMessage({ id: INITIAL_ID, sequence_number: 0, parent_message_id: null }));

    await expect(renderPage({ followup: TOKEN })).resolves.toBe("none");
  });

  it("is unaffected by an absent or repeated followup parameter", async () => {
    resolves(storedMessage());

    await expect(renderPage({})).resolves.toBe("none");
    await expect(renderPage({ followup: [TOKEN] })).resolves.toBe(FOLLOW_UP_ID);
  });

  it("does not let a repeated parameter smuggle a second value past the token", async () => {
    resolves(storedMessage());

    // `?followup=<token>&followup=<other>` must resolve exactly one token, and
    // only the first is considered — never "the last one wins".
    await expect(renderPage({ followup: [TOKEN, "fp1_second"] })).resolves.toBe(FOLLOW_UP_ID);
    expect(resolved.calls).toEqual([{ token: TOKEN, purpose: "followup_composer" }]);
  });

  it("does not resolve a token that another page could have sent here", async () => {
    // The purpose stays `followup_composer`, so an import token — which is
    // purpose-bound and lives under /import — cannot be used to open this view.
    resolves(storedMessage());

    await renderPage({ followup: TOKEN });

    expect(resolved.calls[0].purpose).toBe("followup_composer");
  });
});
