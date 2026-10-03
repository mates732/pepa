export function SetupNotice({
  missing,
  detail,
  hint,
}: {
  missing: string[];
  detail?: string;
  hint?: string;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-16">
      <h1 className="text-xl font-semibold tracking-tight text-midnight">
        Outreach Tool
      </h1>

      <div className="mt-6 rounded-[var(--radius-blob)] border-[3px] border-midnight bg-midnight-faint p-5 shadow-[5px_5px_0_0_var(--color-midnight)]">
        <p className="text-sm font-black uppercase tracking-wide text-midnight">Setup required</p>

        {missing.length > 0 ? (
          <>
            <p className="mt-2 text-sm text-midnight">
              These environment variables are not set. Copy <code>.env.example</code> to{" "}
              <code>.env.local</code> and fill in your project values.
            </p>
            <ul className="mt-2 list-inside list-disc font-mono text-sm text-midnight">
              {missing.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </>
        ) : null}

        {detail ? (
          <div className="mt-3">
            <p className="text-sm text-midnight">{detail}</p>
            {hint ? <p className="mt-1 text-sm text-midnight">{hint}</p> : null}
            <p className="mt-2 text-sm text-midnight">
              Apply the schema first:{" "}
              <code className="rounded-md border-2 border-midnight bg-paper px-1.5 py-0.5 font-mono text-[13px]">
                supabase db push
              </code>{" "}
              (or paste{" "}
              <code className="font-mono text-[13px]">
                supabase/migrations/20260101000000_init.sql
              </code>{" "}
              into the Supabase SQL editor).
            </p>
          </div>
        ) : null}
      </div>

      <p className="mt-4 text-sm text-midnight-soft">
        The paste/import and composer still work once Supabase is configured. No
        Gmail, Apple Mail or Telegram integration exists yet — those land in V2.
      </p>
    </main>
  );
}