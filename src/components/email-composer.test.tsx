import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmailComposer, type ComposerValues } from "./email-composer";

/**
 * The composer used to render a "Send" button that was permanently disabled
 * with a "no provider configured" tooltip, because PEPA has no email provider.
 * A permanently disabled button gives no way to record the fact that the
 * operator sent the email themselves, so the send-recording bridge had no way
 * out of the composer.
 *
 * These assertions pin the reachable button and the wording that stops the
 * operator from believing PEPA delivered their mail.
 */
function render(
  overrides: Partial<Omit<React.ComponentProps<typeof EmailComposer>, "values">> & {
    values?: Partial<ComposerValues>;
  } = {},
) {
  const values: ComposerValues = {
    recipient: "info@example.com",
    subject: "Test subject",
    body: "Test body",
    companyName: "",
    contactName: "",
    messageId: null,
    leadId: null,
    ...(overrides.values ?? {}),
  };

  const props: React.ComponentProps<typeof EmailComposer> = {
    onChange: () => {},
    duplicate: null,
    duplicatePending: false,
    duplicateError: null,
    notice: null,
    onClear: () => {},
    onSave: () => {},
    onSend: () => {},
    saving: false,
    savingDone: false,
    gate: null,
    gatePending: false,
    warningsConfirmed: false,
    onOpenInGmail: () => {},
    openingGmail: false,
    ...overrides,
    values,
  };

  return renderToStaticMarkup(<EmailComposer {...props} />);
}

function buttonsOf(markup: string): string[] {
  return markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

describe("EmailComposer — the Open in Gmail safety rule", () => {
  // The compose text is read from the STORED message, so an unsaved draft has
  // nothing to open. That rule is deliberate and must survive; what changed is
  // that a disabled button no longer leaves the reason to be guessed at.
  it("is disabled while the draft is unsaved, and says why", () => {
    const markup = render({ values: { messageId: null } });

    const gmailButton = buttonsOf(markup).find((b) => b.includes("Open in Gmail"));
    expect(gmailButton).toBeDefined();
    expect(gmailButton).toContain("disabled");
    expect(markup).toContain("Save the draft to enable");
  });

  it("is enabled once the draft is saved, and drops the explanation", () => {
    const markup = render({
      values: { messageId: "99999999-9999-4999-8999-999999999999" },
    });

    const gmailButton = buttonsOf(markup).find((b) => b.includes("Open in Gmail"));
    expect(gmailButton).toBeDefined();
    expect(gmailButton).not.toContain("disabled");
    expect(markup).not.toContain("Save the draft to enable");
  });

  it("keeps stating that opening Gmail sends nothing", () => {
    const markup = render({
      values: { messageId: "99999999-9999-4999-8999-999999999999" },
    });

    expect(markup).toContain("does not send anything and does not mark it as sent");
  });
});

describe("EmailComposer send button", () => {
  it("is rendered and enabled when the draft is saved", () => {
    const markup = render();
    const sendButton = buttonsOf(markup).find((button) => button.includes("Mark as sent"));

    expect(sendButton).toBeDefined();
    expect(sendButton).not.toContain("disabled");
  });

  it("no longer advertises itself as a send", () => {
    const markup = render();

    // A bare "Send" label is what made operators think PEPA delivers mail.
    expect(markup).not.toMatch(/>\s*Send\s*</);
    expect(markup).toContain("Mark as sent");
  });

  it("states plainly that PEPA does not send email", () => {
    const markup = render();

    expect(markup).toContain("PEPA does not send email");
    // The old tooltip blamed configuration instead of stating the real limit.
    expect(markup).not.toContain("No email provider is configured");
  });

  it("shows progress wording while the send is being recorded", () => {
    expect(render({ saving: true })).toContain("Recording");
  });

  it("keeps save and clear reachable", () => {
    const markup = render();

    expect(markup).toContain("Save draft");
    expect(markup).toContain("Clear");
  });
});