-- Outreach tool — remove browser-facing grants from PEPA tables.
--
-- Why this exists:
--   Supabase grants `anon` and `authenticated` all table privileges in the
--   `public` schema via ALTER DEFAULT PRIVILEGES. Creating a table there
--   therefore inherits SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
--   for both roles — not because PEPA wanted it.
--
--   RLS is enabled on all four tables with zero policies, so those grants are
--   inert today: Postgres treats RLS-with-no-policy as deny-all, and the
--   anon key returns no rows. But that left the whole security posture resting
--   on a single control. If RLS were ever disabled by a bad migration, or a
--   table were recreated without `enable row level security`, the anon key —
--   which is public by definition, since it ships to the browser — would gain
--   full read and write access to every lead and every outreach body.
--
--   PEPA never talks to Supabase from the browser. `getSupabaseBrowserClient()`
--   in src/lib/supabase/client.ts is unused dead code, and src/proxy.ts keeps
--   every route behind the PEPA password gate. Removing the grants makes that
--   true at the database level rather than only by convention.
--
--   SELECT and TRIGGER are revoked as well, not just the four write
--   privileges. SELECT is dead weight for a role that has no policy to satisfy,
--   and TRIGGER can install a trigger that writes. Revoking all of them means
--   the anon key can do nothing to a PEPA table regardless of RLS state.
--
--   The two views are revoked too. Both are declared `security_invoker = true`,
--   so today an anon read is evaluated as the caller and hits RLS on the
--   underlying tables and is denied — the grant is inert. But `outreach_overview`
--   and `due_followups` return every lead's email address, and leaving a SELECT
--   grant on them would leave exactly the exposure this migration exists to
--   close. Revoking all of it means no PEPA object, table or view, is
--   reachable with the public anon key.
--
-- Scope:
--   * Only `anon` and `authenticated` are touched. `service_role` keeps every
--     privilege, so src/lib/supabase/server.ts is unaffected — it bypasses RLS
--     and is the only path the application uses.
--   * `postgres` is untouched, so Supabase Studio, the SQL editor and the CLI
--     keep working.
--   * No table, view, constraint, index, policy or RLS setting is altered.

-- PostgreSQL has no `ON VIEW` keyword: a view is a relation, so GRANT/REVOKE
-- addresses it through `ON TABLE`. `public.outreach_overview` and
-- `public.due_followups` therefore appear in the same statement.
revoke all privileges on table
    public.leads,
    public.outreach_messages,
    public.action_tokens,
    public.followup_notifications,
    public.outreach_overview,
    public.due_followups
  from anon, authenticated;

-- Self-check. Supabase applies each migration in a transaction, so if anything
-- is still granted the whole file rolls back and `supabase db push` fails
-- rather than leaving a half-hardened database behind.
do $$
declare
  leftover record;
begin
  select relname as object_name, grantee, privilege_type into leftover
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_roles r on r.oid = c.relowner
  cross join lateral (
    select g.rolname as grantee, aclexplode.privilege_type as privilege_type
    from aclexplode(c.relacl)
    join pg_roles g on g.oid = aclexplode.grantee
    where g.rolname in ('anon', 'authenticated')
  ) x
  where n.nspname = 'public'
    and c.relname in (
      'leads', 'outreach_messages', 'action_tokens', 'followup_notifications',
      'outreach_overview', 'due_followups'
    )
  limit 1;

  if leftover is not null then
    raise exception
      'migration 004 did not remove browser grants: % still has % on %',
      leftover.grantee, leftover.privilege_type, leftover.object_name;
  end if;
end
$$;