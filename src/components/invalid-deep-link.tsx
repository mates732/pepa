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
      <h1 className="heading-sticker text-center text-xl text-midnight">
        PEPA the Outman
      </h1>

      <div className="mt-6 rounded-[var(--radius-blob)] border-[3px] border-midnight bg-midnight-faint p-5 shadow-[5px_5px_0_0_var(--color-midnight)]">
        <p className="text-sm font-black uppercase tracking-wide text-midnight">Link unavailable</p>
        <p className="mt-1 text-sm text-midnight">{message}</p>
      </div>

      <p className="mt-4 text-center text-sm">
        <Link href="/" className="text-midnight underline underline-offset-4">
          Go to the dashboard
        </Link>
      </p>
    </main>
  );
}