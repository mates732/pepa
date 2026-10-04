import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for `openImportInGmail` — the last hop of ChatGPT → PEPA → Gmail.
 *
 * This is the action a deep link's "Open in Gmail" button calls. The properties
 * under test are the security properties of the deep-link system, not cosmetics:
 *
 *   * a PEPA session is required, and the guard runs before the token is
 *     touched, so private lead data is never reachable anonymously;
 *   * the caller sends ONLY a token. No message id, no lead id, no recipient, no
 *     subject, no body — a crafted request therefore cannot compose an email to
 *     an address of its choosing or retarget a token;
 *   * the compose URL is built from the STORED row by the same
 *     `buildGmailComposeUrl` service the dashboard uses, so recipient, subject
 *     and body round-trip exactly, diacritics and newlines included;
 *   * every token failure mode is refused safely and indistinguishably: bad
 *     format, unknown, expired, and — critically — a token minted for a
 *     different purpose;
 *   * it is strictly a read. No update, no `sent_at`, no counter, no transport.
 *     Nothing here can send an email.
 */

const mocks = vi.hoisted(() => ({
  requireAuthenticatedUser: vi.fn(),
  resolveOutreachImport: vi.fn(),
  writes: [] as string[],
  transport: [] as string[],
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/dal", () => ({
  requireAuthenticatedUser: mocks.requireAuthenticatedUser,
  verifySession: async () => ({ id: "owner", since: 0 }),
}));

vi.mock("@/lib/services/import-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/services/import-service");
  return { ...actual, resolveOutreachImport: mocks.resolveOutreachImport };
});

/**
 * The Supabase client is not reachable from this action at all — every read
 * goes through `resolveOutreachImport`, which is mocked above. Mocking it anyway
 * turns "this action must never write" into a failing assertion rather than a
 * claim: any write verb reaching it throws.
 */
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseAdmin: () => {
    const builder: Record<string, unknown> = {};
    const forbid = (verb: string) => () => {
      mocks.writes.push(verb);
      throw new Error(`unexpected write: ${verb}`);
    };
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.maybeSingle = async () => ({ data: null, error: null });
    builder.insert = forbid("insert");
    builder.update = forbid("update");
    builder.upsert = forbid("upsert");
    builder.delete = forbid("delete");
    return builder;
  },
}));

// Nothing in the action graph may reach a transport: composing is not sending.
vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: (...args: unknown[]) => {
    mocks.transport.push("telegram");
    void args;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** A draft exactly as `resolveOutreachImport` returns it for a valid token. */
function resolvedDraft(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    error: null as string | null,
    data: {
      imported: true,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lead: {
        id: "22222222-2222-4222-8222-222222222222",
        email: "katy@beautysalon.cz",
        company_name: "Beautysalon",
        contact_name: "Kateřina Klimentová",
      },
      message: {
        id: "11111111-1111-4111-8111-111111111111",
        lead_id: "22222222-2222-4222-8222-222222222222",
        recipient_email: "katy@beautysalon.cz",
        subject: "AI recepce pro Beautysalon v Průhonicích",
        body: "Dobrý den, paní Klimentová,\n\nDěláme AI recepci.\n\nDíky, Pavel",
        status: "draft",
        sent_at: null,
        sequence_number: 0,
        ...overrides,
      },
    },
  };
}

/** Pull a parameter back out of a compose URL, the same way the browser would. */
function param(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

async function open() {
  const { openImportInGmail } = await import("@/app/import-actions");
  return openImportInGmail({ token: "fp1_test-token" });
}

beforeEach(() => {
  mocks.writes.length = 0;
  mocks.transport.length = 0;
  mocks.requireAuthenticatedUser.mockReset().mockResolvedValue({ id: "owner" });
  mocks.resolveOutreachImport.mockReset().mockResolvedValue(resolvedDraft());
});

describe("openImportInGmail — authentication", () => {
  it("rejects an unauthenticated caller", async () => {
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));

    await expect(open()).rejects.toThrow("AuthenticationError");
  });

  it("checks the session before it resolves the token", async () => {
    // Order matters: an anonymous caller must not be able to make PEPA look up a
    // token at all.
    mocks.requireAuthenticatedUser.mockRejectedValue(new Error("AuthenticationError"));

    await expect(open()).rejects.toThrow("AuthenticationError");
    expect(mocks.resolveOutreachImport).not.toHaveBeenCalled();
  });
});

describe("openImportInGmail — token failures are safe", () => {
  it("refuses an expired token without leaking why", async () => {
    // The service collapses unknown / expired / wrong-purpose into one message;
    // the action must pass it through unchanged rather than re-deriving a cause.
    mocks.resolveOutreachImport.mockResolvedValue({
      ok: false,
      error: "This link is invalid or has expired.",
    });

    const result = await open();
    expect(result).toEqual({ ok: false, error: "This link is invalid or has expired." });
  });

  it("refuses a malformed or unknown token", async () => {
    mocks.resolveOutreachImport.mockResolvedValue({
      ok: false,
      error: "This link is invalid or has expired.",
    });

    expect((await open()).ok).toBe(false);
  });

  it("refuses a token minted for a different purpose", async () => {
    // A `followup_composer` token does not resolve under the `outreach_import`
    // purpose, so the failure is indistinguishable from any other.
    mocks.resolveOutreachImport.mockResolvedValue({
      ok: false,
      error: "This link is invalid or has expired.",
    });

    const result = await open();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(
      "This link is invalid or has expired.",
    );
  });

  it("never returns a URL when the token does not resolve", async () => {
    mocks.resolveOutreachImport.mockResolvedValue({ ok: false, error: "nope" });

    const result = await open();
    expect("url" in result).toBe(false);
  });
});

describe("openImportInGmail — the exact stored draft", () => {
  it("preserves the exact recipient, subject and body", async () => {
    const result = await open();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(param(result.url, "to")).toBe("katy@beautysalon.cz");
    expect(param(result.url, "su")).toBe("AI recepce pro Beautysalon v Průhonicích");
    expect(param(result.url, "body")).toBe(
      "Dobrý den, paní Klimentová,\n\nDěláme AI recepci.\n\nDíky, Pavel",
    );
  });

  it("points at the Gmail compose endpoint, not a mailto or a third party", async () => {
    const result = await open();
    if (!result.ok) throw new Error("expected success");

    expect(result.url.startsWith("https://mail.google.com/mail/?")).toBe(true);
    expect(param(result.url, "view")).toBe("cm");
    expect(param(result.url, "fs")).toBe("1");
  });

  it("carries no draft content in anything but the query it is meant to", async () => {
    const result = await open();
    if (!result.ok) throw new Error("expected success");

    // The message id is never exposed to the browser, so a token cannot be
    // swapped for a message reference. Only the two facts the UI needs remain.
    expect(result.url).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(result.sequenceNumber).toBe(0);
    expect(result.isFollowUp).toBe(false);
  });

  it("reports a follow-up draft as a follow-up", async () => {
    mocks.resolveOutreachImport.mockResolvedValue(resolvedDraft({ sequence_number: 1 }));

    const result = await open();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequenceNumber).toBe(1);
    expect(result.isFollowUp).toBe(true);
  });

  it("omits an absent subject rather than sending it blank", async () => {
    mocks.resolveOutreachImport.mockResolvedValue(resolvedDraft({ subject: null }));

    const result = await open();
    if (!result.ok) throw new Error("expected success");
    expect(param(result.url, "su")).toBeNull();
  });
});

describe("openImportInGmail — it only ever prepares a draft", () => {
  it("refuses a message that has already been sent", async () => {
    mocks.resolveOutreachImport.mockResolvedValue(
      resolvedDraft({ status: "sent", sent_at: "2026-10-04T10:00:00.000Z" }),
    );

    const result = await open();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already been sent/i);
  });

  it("writes nothing: no status, no sent_at, no counter", async () => {
    await open();

    expect(mocks.writes).toEqual([]);
  });

  it("sends nothing and notifies nobody", async () => {
    await open();

    expect(mocks.transport).toEqual([]);
  });

  it("re-resolves the token server-side on every call", async () => {
    // Idempotent: opening the link twice is two reads, never two drafts.
    await open();
    await open();

    expect(mocks.resolveOutreachImport).toHaveBeenCalledTimes(2);
    expect(mocks.writes).toEqual([]);
  });
});
