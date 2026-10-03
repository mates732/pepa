import { ImportEditor } from "@/components/import-editor";
import { InvalidDeepLink } from "@/components/invalid-deep-link";
import { verifySession } from "@/lib/auth/dal";
import { formatDateTime } from "@/lib/format";
import { resolveOutreachImport } from "@/lib/services/import-service";

/**
 * Imported-draft landing page: `/import/<opaque-token>`.
 *
 * Flow (mirrors the follow-up deep link):
 *   unauthenticated → Proxy redirects to /login?next=/import/<token>
 *                    → after login the operator returns straight here
 *   authenticated   → the token is resolved with purpose `outreach_import`
 *
 * The URL carries nothing but a random token. Recipient, subject and body are
 * loaded server-side from the token digest, so `/import/1` cannot be used to
 * probe leads, and no outreach content ever appears in a URL, a referrer or a
 * server log line.
 *
 * An import is a DRAFT. The page says so plainly, because the distinction the
 * whole design rests on is that importing is not sending.
 */
export default async function ImportPage({ params }: PageProps<"/import/[token]">) {
  // Server remains the source of truth: Proxy is only an optimistic redirect.
  await verifySession();

  const { token } = await params;
  const resolved = await resolveOutreachImport(token);

  if (!resolved.ok) {
    return <InvalidDeepLink message={resolved.error} />;
  }

  const { lead, message, expiresAt } = resolved.data;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-10">
      <header className="mb-6">
        <h1 className="heading-sticker text-center text-xl text-midnight">
          PEPA the Outman
        </h1>
        <p className="mt-1 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-midnight-soft">
          Imported draft
        </p>
      </header>

      <section className="sticker">
        <div className="space-y-1 border-b-[3px] border-midnight px-5 py-4">
          <h2 className="heading-sticker text-lg text-midnight">
            {lead.company_name || lead.contact_name || lead.email}
          </h2>
          <p className="font-mono text-xs break-all text-midnight-soft">{lead.email}</p>
          <p className="pt-1 text-xs text-midnight-soft">
            Last contact: {formatDateTime(lead.last_contacted_at)}
          </p>
          <p className="text-xs text-midnight-soft">
            Message status: <span className="font-medium">{message.status}</span> · import link
            valid until {formatDateTime(expiresAt)}
          </p>
        </div>

        <div className="p-5">
          <ImportEditor
            token={token}
            recipient={message.recipient_email}
            subject={message.subject ?? ""}
            body={message.body ?? ""}
          />

          <div className="mt-4 notice text-xs">
            This message was generated outside PEPA and imported as a{" "}
            <span className="font-medium">draft</span>. Importing does not send anything — review
            it, edit it, then send it from your own mail client. Sending from inside PEPA arrives
            with the EmailProvider implementation.
          </div>
        </div>
      </section>
    </main>
  );
}

