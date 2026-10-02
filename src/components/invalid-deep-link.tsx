import Link from "next/link";

interface InvalidDeepLinkProps {
  message: string;
}

/**
 * Shown for an unknown, malformed, wrong-purpose or expired token. The message is
 * identical in every case so the page cannot be used to probe for valid tokens.
 */
export function InvalidDeepLink({ message }: InvalidDeepLinkProps) {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-20">
      <h1 className="text-center text-sm font-semibold tracking-[0.2em] text-neutral-900 uppercase">
        PEPA the Outman
      </h1>

      <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-medium text-amber-900">Link unavailable</p>
        <p className="mt-1 text-sm text-amber-900">{message}</p>
      </div>

      <p className="mt-4 text-center text-sm">
        <Link href="/" className="text-neutral-700 underline underline-offset-4">
          Go to the dashboard
        </Link>
      </p>
    </main>
  );
}