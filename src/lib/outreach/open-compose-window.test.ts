import { describe, expect, it } from "vitest";

import {
  closeComposeWindow,
  navigateComposeWindow,
  preopenComposeWindow,
  type ComposeWindowHandle,
  type WindowOpener,
} from "@/lib/outreach/open-compose-window";

/**
 * The popup-blocking fix, pinned.
 *
 * The bug: `window.open` ran after `await`, which ends the user-gesture chain,
 * so browsers blocked the tab — and the handler still reported success. The fix
 * reserves the tab synchronously during the click and navigates it afterwards.
 *
 * These assertions are about that reservation contract specifically, because it
 * is the part that silently regresses: nothing fails at build time if someone
 * moves the `open` call back behind the `await`.
 */

function fakeHandle(): ComposeWindowHandle & { closed: boolean } {
  return {
    location: { href: "" },
    closed: false,
    close() {
      this.closed = true;
    },
    opener: { name: "pepa" },
  };
}

describe("preopenComposeWindow", () => {
  it("reserves a tab synchronously, before any network round trip", () => {
    const calls: Array<[string, string | undefined]> = [];
    const handle = fakeHandle();
    const open: WindowOpener = (url, target) => {
      calls.push([url, target]);
      return handle;
    };

    const reserved = preopenComposeWindow(open);

    expect(reserved).toBe(handle);
    expect(calls).toEqual([["about:blank", "_blank"]]);
  });

  it("does NOT pass noopener, which would make window.open return null", () => {
    const seen: unknown[][] = [];
    const open: WindowOpener = (...args) => {
      seen.push(args);
      return fakeHandle();
    };

    preopenComposeWindow(open);

    // Exactly two arguments. A third "noopener" argument is exactly the bug this
    // module exists to avoid.
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]).not.toContain("noopener");
  });

  it("still isolates the opened tab by nulling the opener", () => {
    const handle = fakeHandle();
    preopenComposeWindow(() => handle);

    expect(handle.opener).toBeNull();
  });

  it("reports null when the browser refuses even a blank tab", () => {
    expect(preopenComposeWindow(() => null)).toBeNull();
  });

  it("survives a handle that refuses the opener assignment", () => {
    const handle = fakeHandle();
    Object.defineProperty(handle, "opener", {
      set() {
        throw new Error("cross-origin");
      },
      get() {
        return null;
      },
    });

    expect(preopenComposeWindow(() => handle)).toBe(handle);
  });
});

describe("navigateComposeWindow", () => {
  it("sends the reserved tab to the compose URL", () => {
    const handle = fakeHandle();
    const url = "https://mail.google.com/mail/?view=cm&fs=1&to=katy%40beautysalon.cz";

    expect(navigateComposeWindow(handle, url)).toBe(true);
    expect(handle.location.href).toBe(url);
  });

  it("fails honestly when there is no tab, so the caller never claims success", () => {
    expect(navigateComposeWindow(null, "https://mail.google.com/mail/?view=cm")).toBe(false);
  });

  it("fails rather than reviving a tab the operator already closed", () => {
    const handle = fakeHandle();
    handle.closed = true;

    expect(navigateComposeWindow(handle, "https://mail.google.com/mail/?view=cm")).toBe(false);
    expect(handle.location.href).toBe("");
  });
});

describe("closeComposeWindow", () => {
  it("closes the blank tab when the compose URL could not be produced", () => {
    const handle = fakeHandle();

    closeComposeWindow(handle);
    expect(handle.closed).toBe(true);
  });

  it("is a no-op for a missing or already-closed tab", () => {
    expect(() => closeComposeWindow(null)).not.toThrow();
    const handle = fakeHandle();
    handle.closed = true;
    expect(() => closeComposeWindow(handle)).not.toThrow();
  });
});
