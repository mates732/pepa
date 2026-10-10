"use client";

import { useCallback, useState } from "react";

import type { GmailComposeInput } from "@/lib/outreach/gmail-compose-client";
import { openGmailCompose, buildGmailAppUrl, isIOS } from "@/lib/outreach/open-gmail-compose";

/**
 * "Open in Gmail" button — provides browser compose and optional Gmail app option.
 *
 * On desktop: opens Gmail compose in the same tab.
 * On iOS: opens Gmail compose in the same tab, with an optional link to try the Gmail app.
 *
 * The caller supplies the draft data (recipient, subject, body) — never
 * a URL, never a server action — and this component handles the navigation.
 *
 * SECURITY. The caller supplies raw draft data, which is already rendered on
 * this page and comes from the database. No value typed into this component
 * can influence what Gmail receives. Opening Gmail writes nothing: the
 * operator still presses Send in Gmail, and that stays the only step that
 * sends an email.
 */
export function GmailComposeButton({
  input,
  label = "Open in Gmail ↗",
  disabled = false,
  title = "Opens a Gmail draft with this saved text. This does not send anything.",
}: {
  input: GmailComposeInput;
  label?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [showAppOption, setShowAppOption] = useState(false);

  const handleBrowserCompose = useCallback(() => {
    // Synchronous, inside the click: the user gesture is still live here.
    // Uses same-tab navigation to avoid popup blocking on mobile browsers.
    openGmailCompose(input);
  }, [input]);

  const handleTryGmailApp = useCallback(() => {
    // On iOS, mailto: URLs may open the Gmail app if configured as default.
    // This is not guaranteed — it depends on iOS settings.
    if (typeof window !== "undefined") {
      window.location.assign(buildGmailAppUrl(input));
    }
  }, [input]);

  const isIOSDevice = isIOS();

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleBrowserCompose}
        disabled={disabled}
        className="btn"
        title={title}
      >
        {label}
      </button>

      {isIOSDevice && !disabled && (
        <p className="text-xs text-midnight-soft">
          <button
            type="button"
            onClick={handleTryGmailApp}
            className="underline hover:text-midnight font-medium"
          >
            Try opening in Gmail app ←
          </button>
          <span className="block text-[10px] mt-1">
            If the Gmail app is set as your default mail client on iOS, this may open it.
            Otherwise it opens in Mail or your browser.
          </span>
        </p>
      )}
    </div>
  );
}