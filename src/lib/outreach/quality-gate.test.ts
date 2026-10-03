import { describe, expect, it } from "vitest";

import {
  CONTACT_COOLDOWN_DAYS,
  MIN_BODY_LENGTH,
  SUBJECT_HIGH_SIMILARITY,
  SUBJECT_SIMILARITY_FLOOR,
  evaluateQualityGate,
  isClaimSupported,
  findAiMetaArtifacts,
  findPersonalizationClaims,
  findPlaceholders,
  normalizeForComparison,
  resolveIdentity,
  similarity,
  tokenize,
  type GateContext,
  type HistoryMessage,
} from "./quality-gate";

/**
 * The gate is the last thing standing between sloppy AI output and a human
 * sending it, so the tests below are grouped by the failure they prevent rather
 * than by the function they call. Every threshold in the module is pinned here
 * on purpose: a threshold nobody asserted is a threshold nobody reviewed.
 */

const NOW = new Date("2026-10-03T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function history(overrides: Partial<HistoryMessage> = {}): HistoryMessage[] {
  return [
    {
      id: "msg-previous",
      subject: "AI recepce pro váš salon",
      body: "Dobrý den,\n\nrád bych vám nabídl automatizaci fakturací pro váš salon.\n\nS pozdravem\nPetr",
      status: "sent",
      sentAt: daysAgo(30),
      createdAt: daysAgo(31),
      index: 0,
      ...overrides,
    },
  ];
}

function context(partial: Partial<GateContext> = {}): GateContext {
  return {
    input: {
      recipient: "salon@example.com",
      subject: "Automatizace telefonátů ve vašem salonu",
      body:
        "Dobrý den,\n\nzaměstnanci vám volají příliš často?\n\nNabízím řešení, které jim ulehčí práci.\n\nS pozdravem\nPetr",
      messageId: "msg-current",
    },
    history: [],
    now: NOW,
    ...partial,
  };
}

function gate(partial: Partial<GateContext> = {}) {
  return evaluateQualityGate(context(partial));
}

function checkNamed(result: ReturnType<typeof evaluateQualityGate>, name: string) {
  const found = result.checks.find((check) => check.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

/* -------------------------------------------------------------------------- */
/* normalisation                                                              */
/* -------------------------------------------------------------------------- */

describe("normalisation", () => {
  it("folds case, diacritics and punctuation", () => {
    expect(normalizeForComparison("  AI  Recepce, pro VÁŠ salon!  ")).toBe("ai recepce pro vas salon");
  });

  it("collapses repeated whitespace", () => {
    expect(normalizeForComparison("a\n\n\tb   c")).toBe("a b c");
  });

  it("treats diacritic variants as the same word", () => {
    expect(tokenize("váš salon")).toEqual(tokenize("vas salon"));
  });

  it("returns an empty token list for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* similarity primitives                                                      */
/* -------------------------------------------------------------------------- */

describe("similarity", () => {
  it("scores identical text at 1", () => {
    expect(similarity("AI recepce pro váš salon", "ai recepce pro vas salon").score).toBe(1);
  });

  it("scores the spec's reworded repeat as highly similar", () => {
    const result = similarity(
      "Krátký dotaz ohledně AI recepce pro váš salon",
      "AI recepce pro váš salon",
    );
    expect(result.score).toBeGreaterThanOrEqual(SUBJECT_HIGH_SIMILARITY);
  });

  it("scores a different subject as clearly different", () => {
    const result = similarity(
      "Automatizace telefonátů ve vašem salonu",
      "AI recepce pro váš salon",
    );
    expect(result.score).toBeLessThan(SUBJECT_SIMILARITY_FLOOR);
  });

  it("ignores containment when the texts differ wildly in length", () => {
    const shortText = "různé věty o faktu a druhé větě";
    const filler = Array.from({ length: 80 }, (_, i) => `slovo${i}`).join(" ");
    const longText = `${shortText} ${filler}`;
    const result = similarity(shortText, longText);
    expect(result.containmentIgnored).toBe(true);
    expect(result.containment).toBe(0);
  });

  it("is symmetric", () => {
    const a = "AI recepce pro váš salon";
    const b = "Krátký dotaz ohledně AI recepce pro váš salon";
    expect(similarity(a, b).score).toBeCloseTo(similarity(b, a).score, 10);
  });

  it("returns 0 for empty input rather than throwing", () => {
    expect(similarity("", "anything").score).toBe(0);
    expect(similarity("anything", "").score).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* identity / duplicate                                                       */
/* -------------------------------------------------------------------------- */

describe("resolveIdentity", () => {
  it("reports a brand-new lead", () => {
    expect(resolveIdentity(context()).state).toBe("new_lead");
  });

  it("reports an existing draft-only lead without calling it contacted", () => {
    const verdict = resolveIdentity(
      context({
        history: history({ status: "draft", sentAt: null }),
      }),
    );
    expect(verdict.state).toBe("duplicate_draft");
    expect(verdict.contacted).toBe(false);
  });

  it("reports cooldown inside the window", () => {
    const verdict = resolveIdentity(context({ history: history({ sentAt: daysAgo(1) }) }));
    expect(verdict.state).toBe("cooldown");
  });

  it("reports active outreach outside the window", () => {
    const verdict = resolveIdentity(context({ history: history({ sentAt: daysAgo(20) }) }));
    expect(verdict.state).toBe("active_outreach");
  });

  it("treats every contacted status as real outreach", () => {
    for (const status of ["sent", "follow_up", "replied"]) {
      const verdict = resolveIdentity(context({ history: history({ status, sentAt: null }) }));
      expect(verdict.contacted, status).toBe(true);
    }
  });

  it("excludes the draft being evaluated from its own history", () => {
    const verdict = resolveIdentity(
      context({
        input: {
          recipient: "salon@example.com",
          subject: "s",
          body: "b",
          messageId: "msg-previous",
        },
        history: history(),
      }),
    );
    // The only prior message IS the current draft, so nothing was contacted.
    expect(verdict.state).toBe("duplicate_draft");
  });

  it("prefers the lead's own last_contacted_at over history", () => {
    const verdict = resolveIdentity(context({ lastContactedAt: daysAgo(1) }));
    expect(verdict.state).toBe("cooldown");
  });

  it("counts a contact made exactly at the cooldown boundary as outside it", () => {
    const verdict = resolveIdentity(context({ history: history({ sentAt: daysAgo(CONTACT_COOLDOWN_DAYS) }) }));
    expect(verdict.state).toBe("active_outreach");
  });
});

/* -------------------------------------------------------------------------- */
/* gate verdicts — identity                                                    */
/* -------------------------------------------------------------------------- */

describe("gate: identity and duplicate", () => {
  it("1. a brand-new lead is READY", () => {
    expect(gate().status).toBe("ready");
  });

  it("2. an existing draft-only lead does not falsely block", () => {
    const result = gate({ history: history({ status: "draft", sentAt: null }) });
    expect(result.status).not.toBe("blocked");
  });

  it("3. sent outreach inside cooldown is BLOCKED", () => {
    const result = gate({ history: history({ sentAt: daysAgo(1) }) });
    expect(result.status).toBe("blocked");
    expect(checkNamed(result, "identity").reason).toContain("cooldown");
  });

  it("4. historical outreach outside cooldown warns rather than blocks", () => {
    const result = gate({ history: history({ sentAt: daysAgo(45) }) });
    expect(result.status).toBe("warning");
    expect(checkNamed(result, "identity").status).toBe("warn");
  });

  it("5. duplicate email normalisation resolves to the same lead history", () => {
    // " Info@Example.com " and "info@example.com" are one lead by the unique
    // index, so the gate must see the same prior outreach for both spellings.
    const first = gate({ input: { recipient: " info@Example.com ", subject: "x", body: "y" }, history: history({ sentAt: daysAgo(1) }) });
    const second = gate({ input: { recipient: "info@example.com", subject: "x", body: "y" }, history: history({ sentAt: daysAgo(1) }) });
    expect(first.status).toBe("blocked");
    expect(second.status).toBe("blocked");
  });
});

/* -------------------------------------------------------------------------- */
/* gate verdicts — subject                                                     */
/* -------------------------------------------------------------------------- */

describe("gate: subject anti-repeat", () => {
  const withSubject = (subject: string, past: HistoryMessage[]) =>
    gate({ input: { recipient: "a@b.cz", subject, body: "Dobrý den,\n\nzcela odlišný text o jiné téma.\n\nS pozdravem", messageId: "cur" }, history: past });

  it("6. an exactly repeated subject is BLOCKED", () => {
    const result = withSubject("AI recepce pro váš salon", history());
    expect(checkNamed(result, "subject_unique").status).toBe("block");
  });

  it("normalises case and punctuation before comparing (9)", () => {
    const result = withSubject("  ai  RECEPCE, pro VÁŠ salon!  ", history());
    expect(checkNamed(result, "subject_unique").status).toBe("block");
  });

  it("7. a highly similar reworded subject is detected as a warning", () => {
    const result = withSubject("Krátký dotaz ohledně AI recepce pro váš salon", history());
    const check = checkNamed(result, "subject_unique");
    expect(check.status).toBe("warn");
    expect(check.reason).toContain("similar");
  });

  it("8. a clearly different subject passes", () => {
    const result = withSubject("Automatizace telefonátů ve vašem salonu", history());
    expect(checkNamed(result, "subject_unique").status).toBe("pass");
  });

  it("only compares against messages that actually went out", () => {
    const result = withSubject("AI recepce pro váš salon", [
      history({ status: "draft", sentAt: null })[0],
    ]);
    expect(checkNamed(result, "subject_unique").status).toBe("pass");
  });
});

/* -------------------------------------------------------------------------- */
/* gate verdicts — body                                                        */
/* -------------------------------------------------------------------------- */

describe("gate: body anti-repeat", () => {
  const sent = history();
  const withBody = (body: string) =>
    gate({ input: { recipient: "a@b.cz", subject: "全新 subject", body, messageId: "cur" }, history: sent });

  it("10. an exactly repeated body is BLOCKED", () => {
    const result = withBody(sent[0].body as string);
    expect(checkNamed(result, "body_unique").status).toBe("block");
  });

  it("11. a highly similar body is detected", () => {
    const result = withBody(
      `${sent[0].body}\n\nPS: ozveme se.`,
    );
    expect(checkNamed(result, "body_unique").status).not.toBe("pass");
  });

  it("12. a clearly different body passes", () => {
    const result = withBody(
      "Dobrý den,\n\nvaše čekání v ordinaci řešíme rezervacím systémem.\n\nOzvěte se.\n\nPetr",
    );
    expect(checkNamed(result, "body_unique").status).toBe("pass");
  });

  it("13. whitespace differences do not hide a repeat (13)", () => {
    const noisy = `  ${(sent[0].body as string).split("\n").join("\n\n  ")}  `;
    expect(checkNamed(withBody(noisy), "body_unique").status).toBe("block");
  });

  it("never returns a historical body in its evidence", () => {
    const result = withBody(sent[0].body as string);
    const rendered = JSON.stringify(result.checks);
    expect(rendered).not.toContain("rád bych vám nabídl");
  });
});

/* -------------------------------------------------------------------------- */
/* placeholders and format                                                    */
/* -------------------------------------------------------------------------- */

describe("gate: placeholders and format", () => {
  const withText = (subject: string, body: string) =>
    gate({ input: { recipient: "a@b.cz", subject, body, messageId: "cur" } });

  it("14. [NAME] is blocked", () => {
    expect(checkNamed(withText("Subject", "Dobrý den [NAME], rád vám píšu ohledně vašeho salonu."), "placeholders").status).toBe("block");
  });

  it("15. {{company}} is blocked", () => {
    expect(checkNamed(withText("Subject", "Dobrý den, pro {{company}} máme řešení pro váš salon."), "placeholders").status).toBe("block");
  });

  it("16. TODO is blocked", () => {
    expect(checkNamed(withText("Subject", "Dobrý den, TODO: doplnit detaily o vašem salonu zde."), "placeholders").status).toBe("block");
  });

  it("detects every documented placeholder marker", () => {
    const hits = findPlaceholders("", "[DOPLŇTE] <company> {{name}} TBD XXX");
    expect(hits.length).toBeGreaterThanOrEqual(5);
  });

  it("17. a normal email is not blocked for placeholders", () => {
    expect(checkNamed(withText("Nabídka", "Dobrý den,\n\nrád bych vám nabídl řešení pro váš salon.\n\nS pozdravem"), "placeholders").status).toBe("pass");
  });

  it("18. a malformed recipient is blocked", () => {
    expect(checkNamed(gate({ input: { recipient: "not-an-email", subject: "s", body: "b" } }), "recipient").status).toBe("block");
  });

  it("blocks an empty recipient", () => {
    expect(checkNamed(gate({ input: { recipient: "", subject: "s", body: "b" } }), "recipient").status).toBe("block");
  });

  it("blocks a comma-separated recipient list", () => {
    expect(checkNamed(gate({ input: { recipient: "a@b.cz, c@d.cz", subject: "s", body: "b" } }), "recipient").status).toBe("block");
  });

  it("accepts a display-name recipient by unwrapping it", () => {
    expect(checkNamed(gate({ input: { recipient: "Jan Novák <jan@b.cz>", subject: "s", body: "b" } }), "recipient").status).toBe("pass");
  });

  it("19. an empty subject is blocked", () => {
    expect(checkNamed(withText("   ", "Dobrý den, tady je dostatečně dlouhý text pro kontrolu."), "subject_present").status).toBe("block");
  });

  it("20. an empty body is blocked", () => {
    expect(checkNamed(withText("Subject", "  "), "body_present").status).toBe("block");
  });

  it("blocks a suspiciously short body", () => {
    const short = withText("Subject", "Dobrý den");
    expect(checkNamed(short, "body_present").status).toBe("block");
    expect(checkNamed(short, "body_present").evidence).toContain(`minimum ${MIN_BODY_LENGTH}`);
  });

  it("21. a raw JSON body is blocked", () => {
    const result = withText("Subject", '{"recipient":"a@b.cz","subject":"ahoj","body":"neco"}');
    expect(checkNamed(result, "ai_artifacts").status).toBe("block");
    expect(checkNamed(result, "ai_artifacts").reason).toContain("JSON");
  });

  it("blocks a markdown code fence", () => {
    const result = withText("Subject", "Dobrý den,\n\n```\nconst x = 1;\n```\n\nS pozdravem");
    expect(checkNamed(result, "ai_artifacts").status).toBe("block");
  });

  it("22. AI meta-commentary is blocked", () => {
    const result = withText("Subject", "Here is your email:\n\nDobrý den, nabízím řešení pro váš salon.");
    expect(checkNamed(result, "ai_artifacts").status).toBe("block");
  });

  it("detects the documented meta phrases", () => {
    expect(findAiMetaArtifacts("", "Sure, here's a quick note.").length).toBeGreaterThan(0);
    expect(findAiMetaArtifacts("", "As an AI I cannot help.").length).toBeGreaterThan(0);
    expect(findAiMetaArtifacts("", "I hope this email finds you well.").length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* evidence                                                                   */
/* -------------------------------------------------------------------------- */

describe("gate: personalisation evidence", () => {
  const claim = "Dobrý den, na vašem webu jsem si všiml online rezervací a rád bych vám nabídl řešení.";

  it("23. supported personalisation passes", () => {
    const result = gate({
      input: { recipient: "a@b.cz", subject: "Nabídka", body: claim, messageId: "cur" },
      evidence: ["Na vašem webu je online rezervace do kalendáře."],
    });
    expect(checkNamed(result, "personalization").status).toBe("pass");
  });

  it("24. an unsupported claim warns and reports missing evidence, not falsity", () => {
    const result = gate({
      input: { recipient: "a@b.cz", subject: "Nabídka", body: claim, messageId: "cur" },
    });
    const check = checkNamed(result, "personalization");
    expect(check.status).toBe("warn");
    expect(check.reason).toContain("no evidence is recorded");
    expect(check.reason).not.toMatch(/\bfalse\b|\bnot true\b/i);
  });

  it("does not count a stopword overlap as evidence", () => {
    const finding = findPersonalizationClaims("s", claim)[0];
    // Evidence made only of function words carries no evidential value.
    expect(isClaimSupported(finding, ["we are for you and it is with us"])).toBe(false);
  });

  it("counts a meaningful overlap as evidence", () => {
    const finding = findPersonalizationClaims("s", claim)[0];
    expect(isClaimSupported(finding, ["Na vašem webu je online rezervace."])).toBe(true);
  });

  it("passes when the draft makes no specific claims", () => {
    const result = gate({
      input: {
        recipient: "a@b.cz",
        subject: "Nabídka",
        body: "Dobrý den,\n\nrád bych vám nabídl naše řešení pro vaši firmu.\n\nS pozdravem",
        messageId: "cur",
      },
    });
    expect(checkNamed(result, "personalization").status).toBe("pass");
  });
});

/* -------------------------------------------------------------------------- */
/* aggregation                                                                */
/* -------------------------------------------------------------------------- */

describe("gate: verdict aggregation", () => {
  it("ready when nothing is wrong", () => {
    const result = gate();
    expect(result.status).toBe("ready");
    expect(result.reasons).toHaveLength(0);
  });

  it("blocked wins over warning", () => {
    const result = gate({
      input: {
        recipient: "not-an-email",
        subject: "Nabídka",
        body: "I noticed you recently expanded to three locations and would like to help.",
        messageId: "cur",
      },
      history: history({ sentAt: daysAgo(1) }),
    });
    expect(result.status).toBe("blocked");
    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it("surfaces every non-passing check rather than dropping warnings", () => {
    const result = gate({ history: history({ sentAt: daysAgo(45) }) });
    expect(result.status).toBe("warning");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("is deterministic — the same input yields the same verdict", () => {
    const context = {
      input: { recipient: "a@b.cz", subject: "Nabídka", body: "Dobrý den, dostatečně dlouhý text.", messageId: "cur" },
      history: history(),
      now: NOW,
    };
    expect(JSON.stringify(evaluateQualityGate(context))).toBe(
      JSON.stringify(evaluateQualityGate(context)),
    );
  });

  it("never leaks a historical body or a token in any reason", () => {
    const result = gate({ history: history() });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("rád bych vám nabídl");
    expect(rendered).not.toMatch(/[0-9a-f]{32,}/i);
  });
});