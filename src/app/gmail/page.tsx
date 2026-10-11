import { connection } from "next/server";

import { verifySession } from "@/lib/auth/dal";

export const metadata = {
  title: "PEPA · Gmail",
};

/**
 * Isolated Gmail compose baseline.
 *
 * Deliberately independent of the outreach Gmail helpers, server actions, and
 * draft data. Both links are plain static anchors with literal hrefs so nothing
 * in Pepa can interfere with how the browser navigates to Gmail.
 *
 * Neither link sends email: each opens a Gmail compose window, and the operator
 * still presses Send in Gmail.
 */
export default async function GmailPage() {
  await connection();
  await verifySession();

  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-white">
      <div className="w-full max-w-md px-4 text-center">
        <h1 className="text-2xl font-bold text-midnight">Gmail</h1>
        <p className="mt-3 text-sm text-midnight-soft">
          Tato stránka pouze otevře Gmail — novou zprávu s prázdným formulářem.
          Nic se neodesílá automaticky.
        </p>

        <a
          href="https://mail.google.com/mail/?view=cm&fs=1"
          className="mt-6 inline-flex w-full items-center justify-center rounded-[0.75rem] border-[2px] border-midnight bg-midnight px-6 py-4 text-base font-bold text-cream transition-opacity hover:opacity-90"
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
