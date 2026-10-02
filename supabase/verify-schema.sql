-- PEPA — production schema verification.
--
-- READ-ONLY. Run this AFTER applying supabase/migrations/*.sql to the real
-- Supabase database. It asserts that every object the application depends on
-- exists, and raises an exception naming the first thing that is missing.
--
-- Usage:
--   supabase db execute --file supabase/verify-schema.sql
-- or paste it into Supabase Studio -> SQL Editor and run it.
--
-- It never inserts, updates or deletes: running it twice is harmless.

-- ---------------------------------------------------------------------------
-- 1. Tables exist and Row Level Security is enabled on all of them
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['leads', 'outreach_messages', 'action_tokens', 'followup_notifications']
  loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
    ) then
      raise exception 'MISSING TABLE: public.% — apply supabase/migrations in order', t;
    end if;

    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then
      raise exception 'RLS DISABLED on public.% — this is a production blocker', t;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Views exist
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  foreach v in array array['due_followups', 'outreach_overview']
  loop
    if not exists (select 1 from pg_views where schemaname = 'public' and viewname = v) then
      raise exception 'MISSING VIEW: public.% — apply supabase/migrations in order', v;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The constraints the application relies on for correctness
-- ---------------------------------------------------------------------------
do $$
declare
  c text;
begin
  foreach c in array array[
    -- dedupe guarantees
    'leads_email_normalized_key',
    'outreach_messages_lead_recipient_key',
    -- token model
    'action_tokens_token_hash_key',
    'action_tokens_purpose_check',
    -- follow-up idempotency
    'followup_notifications_unique'
  ]
  loop
    if not exists (
      select 1 from pg_constraint where connamespace = 'public'::regnamespace and conname = c
    ) then
      raise exception 'MISSING CONSTRAINT: %', c;
    end if;
  end loop;
end
$$;

-- The purpose check must allow exactly the two purposes PEPA mints. If this
-- still says followup_composer only, migration 003 has not been applied and
-- every import will fail with a check-constraint violation.
-- Idempotency must be (lead_id, followup_number), NOT (outreach_id, ...).
do $$
declare
  purpose_def text;
  unique_def text;
begin
  select pg_get_constraintdef(oid) into purpose_def
    from pg_constraint where conname = 'action_tokens_purpose_check';
  if purpose_def !~ 'outreach_import' then
    raise exception
      'action_tokens_purpose_check does not allow outreach_import — apply 20260101000300_outreach_import.sql';
  end if;

  select pg_get_constraintdef(oid) into unique_def
    from pg_constraint where conname = 'followup_notifications_unique';
  if unique_def !~ 'lead_id.*followup_number' then
    raise exception 'followup_notifications_unique is not (lead_id, followup_number)';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Indexes the scheduler and the engine read
-- ---------------------------------------------------------------------------
do $$
declare
  i text;
begin
  foreach i in array array[
    'leads_next_followup_idx',
    'leads_email_normalized_key',
    'outreach_messages_lead_recipient_key',
    'outreach_messages_provider_id_idx',
    'action_tokens_token_hash_key',
    'action_tokens_expires_at_idx',
    'action_tokens_import_idx',
    'followup_notifications_unique',
    'followup_notifications_claimed_idx'
  ]
  loop
    if not exists (
      select 1 from pg_indexes where schemaname = 'public' and indexname = i
    ) then
      raise exception 'MISSING INDEX: %', i;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS posture: no client-facing policies, no grants to anon/authenticated
-- ---------------------------------------------------------------------------
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('leads', 'outreach_messages', 'action_tokens', 'followup_notifications')
  loop
    raise exception
      'UNEXPECTED RLS POLICY %.% on public.% — PEPA is service-role only and needs no policies',
      p.schemaname, p.policyname, p.tablename;
  end loop;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('leads', 'outreach_messages', 'action_tokens', 'followup_notifications')
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    raise exception
      'anon/authenticated has write access to a PEPA table — the browser must never write directly';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Token digests are stored, never raw tokens
-- ---------------------------------------------------------------------------
do $$
declare
  digest_type text;
begin
  select data_type into digest_type from information_schema.columns
    where table_schema = 'public' and table_name = 'action_tokens' and column_name = 'token_hash';

  if digest_type is distinct from 'text' then
    raise exception 'action_tokens.token_hash must be unbounded text, found %', coalesce(digest_type, 'nothing');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Summary
-- ---------------------------------------------------------------------------
select
  'tables' as object_type, count(*)::text as found
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
union all
select 'views', count(*)::text from pg_views where schemaname = 'public'
union all
select 'indexes', count(*)::text from pg_indexes where schemaname = 'public'
union all
select 'rls_policies', count(*)::text from pg_policies where schemaname = 'public'
order by 1;