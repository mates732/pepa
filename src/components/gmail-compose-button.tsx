"use client";

import { useCallback } from "react";

import type { GmailComposeInput } from "@/lib/outreach/gmail-compose-client";
import { buildGmailComposeUrl, buildGmailAppUrl } from "@/lib/outreach/gmail-compose";
import { isIOS, isAndroid } from "@/lib/outreach/open-gmail-compose";

/**
 * "Open in Gmail" button — provides two options on mobile:
 *   1. Try Gmail app via googlegmail:// (best-effort)
 *   2. Open browser compose (reliable fallback)
 *
 * On desktop: opens browser compose directly.
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
  const handleTryGmailApp = useCallback(() => {
    // Try to open Gmail app via googlegmail:// scheme.
    // This is best-effort — may not work on all Gmail versions or iOS configs.
    // If it fails, user can use the browser compose button below.
    if (typeof window !== "undefined") {
      window.location.assign(buildGmailAppUrl(input));
    }
  }, [input]);

  const handleBrowserCompose = useCallback(() => {
    // Reliable fallback: open browser compose directly.
    if (typeof window !== "undefined") {
      window.location.assign(buildGmailComposeUrl(input));
    }
  }, [input]);

  const isMobile = isIOS() || isAndroid();

  return (
    <div className="space-y-3">
      {isMobile ? (
        <>
          <button
            type="button"
            onClick={handleTryGmailApp}
            disabled={disabled}
            className="btn btn-primary"
          >
            Otevřít v aplikaci Gmail
          </button>
          <p className="text-[12px] text-midnight-soft">
            Pokud aplikace Gmail není nainstalována nebo iOS/Android odmítne otevřít,
            použijte níže uvedenou možnost.
          </p>
          <button
            type="button"
            onClick={handleBrowserCompose}
            disabled={disabled}
            className="btn"
          >
            Otevřít Gmail na webu (vždy funguje)
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