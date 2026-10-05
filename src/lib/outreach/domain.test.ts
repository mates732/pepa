import { describe, expect, it } from "vitest";

import {
  allowsDomainLevelBlock,
  domainFromEmail,
  isSharedEmailProviderDomain,
  normalizeDomain,
  SHARED_EMAIL_PROVIDER_DOMAINS,
} from "./domain";

/**
 * The canonical domain identity.
 *
 * Every spelling of one company must fold to one value, and — just as
 * important — a value that is not a hostname must fold to nothing at all. A
 * phantom identity here would block a stranger's outreach, which is worse than
 * missing a duplicate.
 */

describe("normalizeDomain", () => {
  it.each([
    ["bistro.cz", "bistro.cz"],
    ["BISTRO.CZ", "bistro.cz"],
    ["  Bistro.CZ  ", "bistro.cz"],
    ["https://www.bistro.cz", "bistro.cz"],
    ["http://bistro.cz/", "bistro.cz"],
    ["HTTPS://WWW.Bistro.CZ/menu?table=4#top", "bistro.cz"],
    ["//www.bistro.cz", "bistro.cz"],
    ["www.bistro.cz.", "bistro.cz"],
    ["bistro.cz:8443", "bistro.cz"],
    ["<https://bistro.cz>", "bistro.cz"],
    ["bistro.cz/some/deep/path", "bistro.cz"],
    ["www.www.bistro.cz", "www.bistro.cz"],
  ])("folds %s to %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    [null],
    [undefined],
    ["bistro"], // a single label is a host, not a domain
    ["bistro..cz"], // an empty label is not a hostname
    ["bistro .cz"],
    ["bistro_cz"],
    ["büstro.cz"],
    ["someone:bistro.cz"],
  ])("refuses %s rather than inventing an identity", (input) => {
    expect(normalizeDomain(input as string | null | undefined)).toBe("");
  });

  it("rejects a hostname longer than the DNS limit", () => {
    expect(normalizeDomain(`${"a".repeat(251)}.cz`)).toBe("");
  });

  it("never folds two different companies together", () => {
    expect(normalizeDomain("bistro.cz")).not.toBe(normalizeDomain("hospoda.cz"));
    expect(normalizeDomain("https://www.bistro.cz")).toBe(normalizeDomain("bistro.cz/"));
  });
});

describe("domainFromEmail", () => {
  it("reads the domain part in canonical form", () => {
    expect(domainFromEmail("Info@WWW.Bistro.CZ")).toBe("bistro.cz");
    expect(domainFromEmail("info+bistro@gmail.com")).toBe("gmail.com");
  });

  it.each([["not-an-email"], ["@bistro.cz"], ["info@"], [""], [null]])(
    "returns nothing for %s",
    (input) => {
      expect(domainFromEmail(input as string | null)).toBe("");
    },
  );
});

describe("shared mailbox providers", () => {
  it.each([
    ["gmail.com"],
    ["googlemail.com"],
    ["outlook.com"],
    ["hotmail.com"],
    ["seznam.cz"],
    ["centrum.cz"],
    ["volny.cz"],
    ["email.cz"],
    ["icloud.com"],
    ["yahoo.co.uk"],
    ["outlook.de"],
    ["hotmail.fr"],
    ["gmx.de"],
    ["yandex.ru"],
    ["protonmail.com"],
  ])("treats %s as a mailbox, not a company", (domain) => {
    expect(isSharedEmailProviderDomain(domain)).toBe(true);
    // And therefore never a domain-level block.
    expect(allowsDomainLevelBlock(domain)).toBe(false);
  });

  it.each([
    ["bistro.cz"],
    ["hospoda.cz"],
    ["drogerieteta.cz"],
    ["gmail.company.cz"],
    ["seznamfirmy.cz"],
    ["outlookhotel.cz"],
  ])("treats %s as a company domain", (domain) => {
    expect(isSharedEmailProviderDomain(domain)).toBe(false);
    expect(allowsDomainLevelBlock(domain)).toBe(true);
  });

  it("normalizes before deciding", () => {
    expect(allowsDomainLevelBlock("https://WWW.GMail.com/")).toBe(false);
    expect(allowsDomainLevelBlock("HTTPS://WWW.Bistro.CZ/")).toBe(true);
  });

  it("refuses a domain-level block for nothing at all", () => {
    // No domain means no company identity to protect, and inventing one would
    // let an unusable address block everyone.
    expect(allowsDomainLevelBlock("")).toBe(false);
    expect(allowsDomainLevelBlock(null)).toBe(false);
  });

  it("lists no provider twice", () => {
    expect(new Set(SHARED_EMAIL_PROVIDER_DOMAINS).size).toBe(SHARED_EMAIL_PROVIDER_DOMAINS.size);
  });
});