"use client";

import { useState } from "react";

import type { OpenInGmailResult } from "@/app/actions";
import {
  closeComposeWindow,
  navigateComposeWindow,
  preopenComposeWindow,
} from "@/lib/outreach/open-compose-window";

/**
 * "Open in Gmail" for the deep-link views, using the one existing popup-safe
 * mechanism.
 *
 * WHY THIS COMPONENT EXISTS. The dashboard has three Gmail handlers, each with
 * the same four-step ceremony: reserve a tab synchronously inside the click,
 * await the server's compose URL, navigate the reserved tab, and — if the
 * browser refused the tab — hand the URL over instead of silently claiming
 * success. That ordering lives in `lib/outreach/open-compose-window.ts` and is
 * the fix for the silent "Gmail opened" report.
 *
 * Rather than paste that ceremony a fourth time for the import deep link, this
 * button owns it. It is not a second implementation: it calls the very same
 * `preopenComposeWindow` / `navigateComposeWindow` / `closeComposeWindow`
 * helpers, and the URL still comes from a server action.
 *
 * SECURITY. The caller supplies a function, never a URL. The compose URL is
 * built server-side from the stored message, so no value rendered in this
 * component can influence what Gmail receives. Opening Gmail writes nothing:
 * `openImportInGmail` performs no update, and the manual Send in Gmail remains
 * the only thing that sends an email.
 */
export function GmailComposeButton({
  open,
  label = "Open in Gmail ↗",
  pendingLabel = "Opening…",
  /** Shown when the window opened successfully. */
  successText = "Gmail opened with the saved text. Nothing was sent — press Send yourself in Gmail.",
}: {
  open: () => Promise<OpenInGmailResult>;
  label?: string;
  pendingLabel?: string;
  successText?: string;
}) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  async function handleClick() {
    setPending(true);
    setNotice(null);

    // Synchronous, inside the click: the user gesture is still live here, which
    // is the entire reason the tab is reserved before the await.
    const tab = preopenComposeWindow();

    try {
      const result = await open();

      if (!result.ok) {
        closeComposeWindow(tab);
        setNotice({ kind: "error", text: result.error });
        return;
      }

      if (!navigateComposeWindow(tab, result.url)) {
        // The browser refused even the blank tab. Say so and hand over the URL
        // rather than reporting an open Gmail that does not exist.
        setNotice({
          kind: "error",
          text: `Your browser blocked the new tab. Open this link manually: ${result.url}`,
        });
        return;
      }

      setNotice({ kind: "info", text: successText });
    } catch (error) {
      // A thrown action (network drop, expired session) must not leave an
      // orphaned blank tab behind, and must not read as success.
      closeComposeWindow(tab);
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Gmail could not be opened.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={pending}
        className="btn"
        title="Opens a Gmail draft with this saved text. This does not send anything and does not mark it as sent."
      >
        {pending ? pendingLabel : label}
      </button>

      {notice ? (
        <p role="status" className={notice.kind === "error" ? "notice notice-alarm" : "notice"}>
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
