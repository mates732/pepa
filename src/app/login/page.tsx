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
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex justify-center">
          <div
            aria-hidden
            className="grid h-12 w-12 place-items-center rounded-xl bg-accent text-xl font-bold text-white shadow-card"
          >
            P
          </div>
        </div>

        <div className="sticker p-6 sm:p-7">
          <h1 className="heading-sticker text-center text-xl text-midnight">
            PEPA the Outman
          </h1>
          <p className="mt-1.5 text-center text-xs font-medium text-midnight-soft">
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
    </div>
  );
}