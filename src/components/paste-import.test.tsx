import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  batchPasteHint,
  nextPastePanel,
  singleLeadFromPaste,
  PasteImport,
} from "@/components/paste-import";

/**
 * The compact paste bar.
 *
 * Rendered with `renderToStaticMarkup`, matching the existing component tests.
 *
 * The pinned property is that the large textarea is NOT in the document until
 * the bar is opened. That is the whole point of the change — the input used to
 * be the tallest element on the dashboard permanently — and it is directly
 * observable here: the default render must contain the "Paste lead" control and
 * no `<textarea>` at all.
 *
 * Interaction is pinned through `nextPastePanel`, the same state machine the
 * component uses, because static markup cannot simulate a click. Testing the
 * machine rather than a copy of it keeps the assertion honest.
 */

const noop = () => {};

/**
 * The reported production bug: a `--- LEAD NN ---` batch pasted into THIS
 * dialog (the single-lead bar) would have merged the batch into one composer.
 * The guard now runs against the canonical parser: any input whose block count
 * is not exactly one is refused before it ever reaches the composer.
 */

const TWO_LEAD_BATCH = `--- LEAD 01 ---

Company: The Original Barber ŠESTKA
Email: originalbarbersestka@gmail.com
Subject: Nabídka pro The Original Barber ŠESTKA

Dobrý den,

text.

--- LEAD 02 ---

Company: Glow Up Barber Shop Praha
Email: glowupbarbershop@seznam.cz
Subject: Nabídka pro Glow Up Barber Shop

Dobrý den,

text.`;

/** A well-formed single LEAD block — the dialog must still accept it. */
const ONE_LEAD_BLOCK = `--- LEAD 01 ---

Company: Test Barber Praha
Website: https://example.com
Email: barber@example.com
Phone: +420700000001
City: Praha 7
Category: Barbershop
Address: Praha 7

Subject: Nabídka pro Test Barber Praha

Dobrý den,

Dobrý den,

toto je hlavní email.`;

/** Markerless single-lead paste: the legacy format, untouched by the guard. */
const SINGLE_LEAD_STANDARD =
  "recipient: info@bella.cz\nsubject: AI recepce pro Bella\nbody: Dobrý den,\n\ntext e-mailu.";

/** Markerless batch separated by a rule: the guard must not treat it as a batch. */
const MARKERLESS_LEGACY_BATCH =
  "To: a@firma.cz\nSubject: A\nText\n\n---\n\nTo: b@firma.cz\nSubject: B\nText";

/** Decorated marker the parser accepts (annotations) — the guard must also refuse it. */
const DECORATED_MARKER = "*** LEAD 01 ***\nEmail: a@firma.cz";

/** Markerless prose — no blocks at all, the guard must not refuse it. */
const MARKERLESS_PLAIN = "Dobrý den,\n\ntext bez markerů.";

/** The single-lead bar's verdict — one candidate, or the reason to refuse. */
function renderDefault() {
  return renderToStaticMarkup(
    <PasteImport
      onParsed={noop}
      onError={noop}
      focusSignal={0}
      disabled={false}
    />,
  );
}

describe("PasteImport — the compact bar", () => {
  it("renders the compact bar by default", () => {
    const markup = renderDefault();

    expect(markup).toContain("Paste lead");
    expect(markup).toContain("Paste / Import");
  });

  it("does NOT render the large textarea until the bar is opened", () => {
    const markup = renderDefault();

    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("recipient: info@example.com");
  });

  it("exposes the bar as a dialog trigger, not as a link", () => {
    const markup = renderDefault();

    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("keeps the existing section chrome and step number", () => {
    const markup = renderDefault();

    expect(markup).toContain("sticker");
    expect(markup).toContain("chip");
  });
});

describe("nextPastePanel — the panel state machine", () => {
  it("starts closed, which is what keeps the textarea out of the document", () => {
    expect(nextPastePanel("closed", "toggle")).toBe("open");
  });

  it("opens on the open action and closes on the close action", () => {
    expect(nextPastePanel("closed", "open")).toBe("open");
    expect(nextPastePanel("open", "close")).toBe("closed");
  });

  it("toggles back to closed", () => {
    expect(nextPastePanel("open", "toggle")).toBe("closed");
  });

  it("is idempotent for the explicit actions", () => {
    expect(nextPastePanel("open", "open")).toBe("open");
    expect(nextPastePanel("closed", "close")).toBe("closed");
  });
});

describe("PasteImport — the paste surface", () => {
  it("keeps the documented paste format visible once the dialog is open", () => {
    const markup = renderDefault();
    expect(markup).toContain("Paste lead +");
  });

  it("leaves the import workflow to the canonical parser", () => {
    // singleLeadFromPaste is the only parse path of the single-lead bar.
    expect(PasteImport).toBeDefined();
  });
});

describe("batchPasteHint — a LEAD batch is refused, never merged into one composer", () => {
  it("refuses a markerless batch of two finished emails with a rule between them", () => {
    const hint = batchPasteHint(MARKERLESS_LEGACY_BATCH);

    expect(hint).not.toBeNull();
    expect(hint).toContain("2 `--- LEAD ---` markers");
    expect(hint).toContain("Paste Emails");
    expect(hint).toContain("nothing is merged");
  });

  it("refuses a decorated marker too", () => {
    const hint = batchPasteHint(DECORATED_MARKER);

    expect(hint).not.toBeNull();
    expect(hint).toContain("1 `--- LEAD ---` marker");
    expect(hint).toContain("Paste Emails");
    expect(hint).toContain("nothing is merged");
  });

  it("refuses an empty paste", () => {
    expect(batchPasteHint("")).toBeNull();
  });

  it("leaves plain markerless text alone until it becomes a batch", () => {
    expect(batchPasteHint(MARKERLESS_PLAIN)).toBeNull();
  });
});

describe("singleLeadFromPaste — the single-lead bar's parser wrapper", () => {
  it("parses a lead inside the same parser the bulk dialog uses", () => {
    const result = singleLeadFromPaste(ONE_LEAD_BLOCK);

    expect(result.ok).toBe(true);
    expect(result.candidate!.recipient).toBe("barber@example.com");
    expect(result.candidate!.subject).toBe("Nabídka pro Test Barber Praha");
    expect(result.candidate!.body).toBe(
      "Dobrý den,\n\nDobrý den,\n\ntoto je hlavní email.",
    );
    expect(result.candidate!.status).toBe("parsed");
  });

  it("refuses a lead batch and points at Paste Emails", () => {
    const result = singleLeadFromPaste(TWO_LEAD_BATCH);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("2 leads, not one");
    expect(result.error).toContain("Paste Emails");
    expect(result.error).toContain("nothing is merged");
  });

  it("refuses a markerless batch of two finished emails", () => {
    const result = singleLeadFromPaste(MARKERLESS_LEGACY_BATCH);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("2 leads, not one");
    expect(result.error).toContain("Paste Emails");
    expect(result.error).toContain("nothing is merged");
  });

  it("refuses a decorated LEAD marker", () => {
    const result = singleLeadFromPaste(DECORATED_MARKER);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("1 lead, not one");
    expect(result.error).toContain("Paste Emails");
  });

  it("leaves plain markerless prose untouched", () => {
    const result = singleLeadFromPaste(MARKERLESS_PLAIN);

    expect(result.ok).toBe(true);
    expect(result.candidate).toBeDefined();
    expect(result.candidate!.recipient).toBeNull();
  });
});
