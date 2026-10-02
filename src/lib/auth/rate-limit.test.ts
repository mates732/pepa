import { beforeEach, describe, expect, it } from "vitest";

import {
  enforceCapacity,
  loginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginAttempts,
  trackedKeys,
} from "./rate-limit";

beforeEach(() => {
  resetLoginAttempts();
});

describe("login throttle", () => {
  it("allows the first attempts", () => {
    expect(loginAllowed("1.1.1.1").allowed).toBe(true);
    expect(recordLoginFailure("1.1.1.1").allowed).toBe(true);
    expect(recordLoginFailure("1.1.1.1").allowed).toBe(true);
  });

  it("locks out after repeated failures with exponential backoff", () => {
    for (let i = 0; i < 4; i += 1) recordLoginFailure("2.2.2.2");

    const locked = recordLoginFailure("2.2.2.2");
    expect(locked.allowed).toBe(false);
    expect(locked.retryAfterSeconds).toBeGreaterThan(0);
    expect(loginAllowed("2.2.2.2").allowed).toBe(false);
  });

  it("grows the lockout with further attempts", () => {
    for (let i = 0; i < 5; i += 1) recordLoginFailure("3.3.3.3");
    const first = loginAllowed("3.3.3.3").retryAfterSeconds;
    for (let i = 0; i < 3; i += 1) recordLoginFailure("3.3.3.3");
    expect(loginAllowed("3.3.3.3").retryAfterSeconds).toBeGreaterThan(first);
  });

  it("expires the lockout after the retry window", () => {
    for (let i = 0; i < 5; i += 1) recordLoginFailure("4.4.4.4");

    const longLater = Date.now() + 60 * 60_000;
    expect(loginAllowed("4.4.4.4", longLater).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 5; i += 1) recordLoginFailure("5.5.5.5");
    expect(loginAllowed("5.5.5.5").allowed).toBe(false);
    expect(loginAllowed("6.6.6.6").allowed).toBe(true);
  });

  it("clears the counter on success", () => {
    for (let i = 0; i < 4; i += 1) recordLoginFailure("7.7.7.7");
    expect(trackedKeys()).toBe(1);

    recordLoginSuccess("7.7.7.7");
    expect(trackedKeys()).toBe(0);
    expect(loginAllowed("7.7.7.7").allowed).toBe(true);
  });

  it("stays bounded", () => {
    for (let i = 0; i < 50; i += 1) {
      enforceCapacity(`10.0.0.${i}`);
      recordLoginFailure(`10.0.0.${i}`);
    }
    expect(trackedKeys()).toBeLessThanOrEqual(5_000);
  });
});