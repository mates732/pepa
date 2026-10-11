import { connection } from "next/server";

import { verifySession } from "@/lib/auth/dal";
import { GmailAppLink } from "./gmail-app-link";
import { buildGmailAppComposeUrl } from "./gmail-app-compose-url";

export const metadata = {
  title: "PEPA · Gmail",
};

/**
 * Isolated Gmail app-launching test page.
 *
 * Independent of the outreach Gmail helpers, server actions, and draft data.
 * Each action is a plain anchor with a URL built or written literally, and
 * explained. Nothing on this page sends email, requests OAuth, or touches a
 * mailbox.
 */

const TEST_COMPOSE_URL = buildGmailAppComposeUrl({
  to: "test@example.com",
  subject: "PEPA TEST",
  body: "Test message",
});

export default async function GmailPage() {
  await connection();
  await verifySession();

  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-white">
      <div className="w-full max-w-md px-4 text-center">
        <h1 className="text-2xl font-bold text-midnight">Gmail</h1>
        <p className="mt-3 text-sm text-midnight-soft">
          Testovací stránka pro otevírání Gmailu na iPhonu. Nic se neodesílá
          automaticky.
        </p>

        {/* 1) App scheme — community-reported, not officially documented. */}
        <div className="mt-6">
          <GmailAppLink />
          <p className="mt-2 text-xs text-midnight-soft">
            Testuje: otevření nainstalované aplikace Gmail přes nespecifikovanou
            schému <code className="text-[11px]">googlegmail://</code> (jen
            komunitně popsaná, Google ji oficiálně nedokumentuje). Pokud
            aplikace není nainstalovaná, stránka se za okamžik přesměruje na
            ověřený webový odkaz níže.
          </p>
        </div>

        {/* 1b) App compose scheme — same app, prefilled fake data. */}
        <div className="mt-6 border-t border-midnight-line pt-6">
          <a
            href={TEST_COMPOSE_URL}
            className="inline-flex w-full items-center justify-center rounded-[0.75rem] border-[2px] border-midnight px-6 py-4 text-base font-bold text-midnight transition-colors hover:bg-midnight-faint"
          >
            Otevřít testovací e-mail v aplikaci Gmail
          </a>
          <p className="mt-2 text-xs text-midnight-soft">
            Testuje: zda aplikace Gmail otevře novou zprávu s předvyplněným
            příjemcem, předmětem a textem (fiktivní data). Úspěch je jen
            vyplněný compose — samotná schránka není úspěch.
          </p>
        </div>

        {/* 2) Verified working web URL (user-tested on iPhone). */}
        <div className="mt-6 border-t border-midnight-line pt-6">
          <a
            href="https://mail.google.com/mail/mu/mp/399/#"
            className="inline-flex w-full items-center justify-center rounded-[0.75rem] border-[2px] border-midnight px-6 py-4 text-base font-bold text-midnight transition-colors hover:bg-midnight-faint"
          >
            Otevřít Gmail na webu
          </a>
          <p className="mt-2 text-xs text-midnight-soft">
            Testuje: ručně ověřenou webovou URL, která na iPhonu otevírá Gmail
            přímo. Neotevírá novou zprávu.
          </p>
        </div>

        {/* 3) Standard compose URL — separate test of compose opening. */}
        <div className="mt-6 border-t border-midnight-line pt-6">
          <a
            href="https://mail.google.com/mail/?view=cm&fs=1&to=test@example.com&su=PEPA%20GMAIL%20TEST&body=Test%20message"
            className="inline-flex w-full items-center justify-center rounded-[0.75rem] border-[2px] border-midnight px-6 py-4 text-base font-bold text-midnight transition-colors hover:bg-midnight-faint"
          >
            Otevřít Gmail compose na webu
          </a>
          <p className="mt-2 text-xs text-midnight-soft">
            Testuje: standardní Gmail compose URL (view=cm) s fiktivními daty —
            otevře novou zprávu v prohlížeči. Na iPhonu se může chovat jinak
            než odkaz výše.
          </p>
        </div>
      </div>
    </div>
  );
}
