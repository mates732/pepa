import { connection } from "next/server";

import { verifySession } from "@/lib/auth/dal";

export const metadata = {
  title: "PEPA · Gmail",
};

/**
 * Isolated Gmail baseline.
 *
 * Deliberately independent of the outreach Gmail helpers, server actions, and
 * draft data. Both links are plain static anchors with literal hrefs so nothing
 * in Pepa can interfere with how the browser navigates to Gmail.
 *
 * PRIMARY LINK — https://mail.google.com/mail/mu/mp/399/#
 *   This exact URL was verified by hand on the user's iPhone: it opens Gmail
 *   itself directly (unlike view=cm compose URLs, which open the Gmail website
 *   in Safari). Its only verified behavior is *opening Gmail*; it is NOT
 *   assumed to open a compose window, and no parameters were added to it.
 *
 * DIAGNOSTIC LINK — bare view=cm compose URL with fake data, kept as a
 *   comparison baseline. Nothing here sends email.
 */
export default async function GmailPage() {
  await connection();
  await verifySession();

  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-white">
      <div className="w-full max-w-md px-4 text-center">
        <h1 className="text-2xl font-bold text-midnight">Gmail</h1>
        <p className="mt-3 text-sm text-midnight-soft">
          Tato stránka pouze otevře Gmail. Nic se neodesílá automaticky.
        </p>

        <p className="mt-2 text-xs text-midnight-soft">
          Otevří Gmail přímo (ověřeno na iPhone). Neotevírá novou zprávu.
        </p>

        <a
          href="https://mail.google.com/mail/mu/mp/399/#"
          className="mt-4 inline-flex w-full items-center justify-center rounded-[0.75rem] border-[2px] border-midnight bg-midnight px-6 py-4 text-base font-bold text-cream transition-opacity hover:opacity-90"
        >
          Otevřít Gmail
        </a>

        <div className="mt-6">
          <a
            href="https://mail.google.com/mail/?view=cm&fs=1&to=test@example.com&su=PEPA%20GMAIL%20TEST&body=Test%20message"
            className="text-sm underline text-midnight-soft hover:text-midnight"
          >
            Testovací e-mail
          </a>
        </div>
      </div>
    </div>
  );
}
