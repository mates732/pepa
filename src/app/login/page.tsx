import { connection } from "next/server";

import { LoginForm } from "@/components/login-form";
import { getAuthEnvStatus } from "@/lib/auth/env";
import type { AuthEnvStatus } from "@/lib/auth/env";
import { safeRedirectPath } from "@/lib/auth/redirect";

export const metadata = {
  title: "Sign in · PEPA",
};

/**
 * The only public page. Proxy redirects an already-authenticated visitor to
 * `/` before this renders.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  await connection();

  const status = getAuthEnvStatus();
  const loginEnabled = (status as AuthEnvStatus).authEnabled;
  const params = await searchParams;
  const requested = Array.isArray(params.next) ? params.next[0] : params.next;

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="tilt mb-3 flex justify-center">
          <div
            aria-hidden
            className="grid h-16 w-16 place-items-center rounded-[1.4rem] border-[3px] border-midnight bg-midnight text-2xl font-black text-cream shadow-[5px_5px_0_0_var(--color-midnight)]"
          >
            P
          </div>
        </div>

        <div className="sticker p-7">
          <h1 className="heading-sticker text-center text-2xl text-midnight">
            PEPA the Outman
          </h1>
          <p className="mt-1 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-midnight-soft">
            Internal Outreach System
          </p>


          <LoginForm next={safeRedirectPath(requested)} disabled={!loginEnabled} />

          {status.configured ? null : (
            <p className="notice notice-alarm mt-5">
              Server is not configured. Set{" "}
              <code className="font-mono">PEPA_PASSWORD</code> and{" "}
              <code className="font-mono">PEPA_SESSION_SECRET</code> (32+ characters).
              See <code className="font-mono">.env.example</code>.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}