import { describe, expect, it } from "vitest";

import { buildComposeUrls } from "./gmail-compose";

describe("buildComposeUrls — test-only surface", () => {
  it("returns both web and mailto URLs for a stored message", () => {
    const urls = buildComposeUrls({
      to: "info@bistrot.cz",
      subject: "Nabídka pro Vaše zákazníky",
      body: "Ahoj, zajímalo by mě, ...",
    });

    // The public API returns `web` (Gmail web compose) and `mailto:` as two
    // distinct supported hand-offs. Tests assert the shape, not the browser's
    // default handler — only the explicit mark-sent action records a send.
    expect(urls.web).toContain("https://mail.google.com/mail/?view=cm");
    expect(urls.web).toContain(encodeURIComponent("info@bistrot.cz"));
    expect(urls.mailto).toContain("mailto:");
    expect(urls.mailto).toContain(encodeURIComponent("info@bistrot.cz"));
  });
});
