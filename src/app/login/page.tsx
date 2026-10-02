import { connection } from "next/server";

import { LoginForm } from "@/components/login-form";
import { getAuthEnvStatus } from "@/lib/auth/env";
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
  const params = await searchParams;
  const requested = Array.isArray(params.next) ? params.next[0] : params.next;

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-center text-lg font-semibold tracking-[0.2em] text-neutral-900 uppercase">
          PEPA the Outman
        </h1>
        <p className="mt-1 text-center text-xs uppercase tracking-widest text-neutral-500">
          Internal Outreach System
        </p>

        <LoginForm next={safeRedirectPath(requested)} disabled={!status.configured} />

        {status.configured ? null : (
          <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Server is not configured. Set{" "}
            <code className="font-mono">PEPA_PASSWORD</code> and{" "}
            <code className="font-mono">PEPA_SESSION_SECRET</code> (32+ characters). See{" "}
            <code className="font-mono">.env.example</code>.
          </p>
        )}
      </div>
    </main>
  );
}