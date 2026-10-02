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
      <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
        Outreach Tool
      </h1>

      <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-900">Setup required</p>

        {missing.length > 0 ? (
          <>
            <p className="mt-2 text-sm text-amber-900">
              These environment variables are not set. Copy <code>.env.example</code> to{" "}
              <code>.env.local</code> and fill in your project values.
            </p>
            <ul className="mt-2 list-inside list-disc font-mono text-sm text-amber-900">
              {missing.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </>
        ) : null}

        {detail ? (
          <div className="mt-3">
            <p className="text-sm text-amber-900">{detail}</p>
            {hint ? <p className="mt-1 text-sm text-amber-900">{hint}</p> : null}
            <p className="mt-2 text-sm text-amber-900">
              Apply the schema first:{" "}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[13px]">
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

      <p className="mt-4 text-sm text-neutral-500">
        The paste/import and composer still work once Supabase is configured. No
        Gmail, Apple Mail or Telegram integration exists yet — those land in V2.
      </p>
    </main>
  );
}