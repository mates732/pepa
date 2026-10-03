"use client";

import { useState, useTransition } from "react";

import { sendTestTelegramNotification } from "@/app/dev-actions";

/**
 * Dev-only affordance: fires a real `sendFollowUpDue()` for the most recent
 * lead so the Telegram → button → PEPA path can be verified by hand.
 * Authenticated server action; never reachable without a PEPA session.
 */
export function TelegramTestButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const response = await sendTestTelegramNotification();
            setResult(
              response.ok
                ? { kind: "ok", text: `Sent to Telegram (message ${response.messageId ?? "?"}).` }
                : { kind: "error", text: response.error },
            );
          })
        }
        className="btn"
      >
        {pending ? "Sending…" : "Test Telegram"}
      </button>
      {result ? (
        <p
          role="status"
          className="max-w-[280px] text-right text-[11px] font-semibold text-midnight"
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}