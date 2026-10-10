"use client";

import { useCallback } from "react";

import type { GmailComposeInput } from "@/lib/outreach/gmail-compose-client";
import { openGmailCompose, isIOS, isAndroid } from "@/lib/outreach/open-gmail-compose";
import { buildGmailAppUrl } from "@/lib/outreach/gmail-compose";

/**
 * "Open in Gmail" button — provides browser compose and optional Gmail app option.
 *
 * On desktop: opens Gmail compose in the same tab.
 * On iOS/Android: offers two options:
 *   - "Otevřít v aplikaci Gmail" — tries googlegmail:// to open the Gmail app
 *   - "Otevřít Gmail na webu" — opens browser compose (reliable fallback)
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
  disabled = false,
  title = "Otevřít v Gmailu — kompozice s předvyplněným obsahem. Neposílá automaticky.",
}: {
  input: GmailComposeInput;
  disabled?: boolean;
  title?: string;
}) {
  const handleBrowserCompose = useCallback(() => {
    // Synchronous, inside the click: the user gesture is still live here.
    // Uses same-tab navigation to avoid popup blocking on mobile browsers.
    openGmailCompose(input);
  }, [input]);

  const handleTryGmailApp = useCallback(() => {
    // Try to open Gmail app via googlegmail:// scheme.
    // This is best-effort — may not work on all Gmail versions or iOS configs.
    if (typeof window !== "undefined") {
      window.location.assign(buildGmailAppUrl(input));
    }
  }, [input]);

  const isMobile = isIOS() || isAndroid();

  return (
    <div className="space-y-2">
      {isMobile ? (
        <>
          <button
            type="button"
            onClick={handleTryGmailApp}
            disabled={disabled}
            className="btn btn-primary"
            title={" Pokus o otevření aplikace Gmail. Nemusí fungovat na všech zařízeních."}
          >
            Otevřít v aplikaci Gmail
          </button>
          <p className="text-[11px] text-midnight-soft">
            Pokud aplikace Gmail není nainstalována nebo iOS/Android odmítne otevřít,
            použijte níže uvedenou možnost.
          </p>
          <button
            type="button"
            onClick={handleBrowserCompose}
            disabled={disabled}
            className="btn"
            title={title}
          >
            Otevřít Gmail na webu
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={handleBrowserCompose}
          disabled={disabled}
          className="btn btn-primary"
          title={title}
        >
          Open in Gmail ↗
        </button>
      )}
    </div>
  );
}