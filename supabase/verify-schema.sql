-- PEPA — production schema verification.
--
-- READ-ONLY. Run this AFTER applying supabase/migrations/*.sql to the real
-- Supabase database. It asserts that every object the application depends on
-- exists, and raises an exception naming the first thing that is missing.
--
-- Usage:
--   supabase db query --linked --file supabase/verify-schema.sql
-- or paste it into Supabase Studio -> SQL Editor and run it.
--
-- It never inserts, updates or deletes: running it twice is harmless.
--
-- ---------------------------------------------------------------------------
-- Sequence identity (migration 20260101000500_outreach_sequence.sql)
-- ---------------------------------------------------------------------------
-- This file originally demanded `outreach_messages_lead_recipient_key`, a
-- UNIQUE (lead_id, recipient_normalized) constraint that the sequence migration
-- deliberately REPLACED. Against a correctly migrated database the gate failed
-- with MISSING CONSTRAINT, and the obvious operator response — re-creating that
-- constraint — would have undone Phase 4A: one row per lead/recipient leaves a
-- follow-up with nowhere to live, which is the defect the migration exists to
-- fix. The gate now asserts the objects that are actually load-bearing.
--
-- KNOWN DEFECT, deliberately not fixed here:
--   The trigger `outreach_messages_parent_same_lead` checks its cross-recipient
--   relationship against `NEW.recipient_normalized`, which
--   is a GENERATED column. Postgres computes generated columns AFTER before-row
--   triggers, so that value is NULL during the trigger and the recipient half of
--   the check never fires. The same-LEAD half works, because `lead_id` is an
--   ordinary column. PEPA's own writers always copy the recipient from the
--   anchor, so no supported write path produces an offending row, and the
--   sequence unique key plus the engine's `skippedAmbiguous` refusal stand
--   behind it. Recorded here so the assertion below is not mistaken for a
--   guarantee it does not currently provide. Fixing it requires a migration and
--   is deferred to an explicitly authorised phase.

-- ---------------------------------------------------------------------------
-- 1. Tables exist and Row Level Security is enabled on all of them
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'leads', 'outreach_messages', 'action_tokens', 'followup_notifications', 'historical_outreach'
  ]
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
    -- dedupe guarantee
    'leads_email_normalized_key',
    -- sequence identity (replaces outreach_messages_lead_recipient_key)
    'outreach_messages_sequence_key',
    'outreach_messages_sequence_number_nonnegative',
    'outreach_messages_parent_is_followup',
    'outreach_messages_parent_message_id_fkey',
    -- historical outreach identity (migration 20260101000600)
    'historical_outreach_email_normalized_key',
    'historical_outreach_email_not_blank',
    'historical_outreach_contact_count_positive',
    'historical_outreach_window_ordered',
    'historical_outreach_source_check',
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
  sequence_def text;
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

  -- One message per sequence slot per lead/recipient. This is what lets a
  -- follow-up exist at all, and what makes concurrent saves conflict instead
  -- of duplicating. A bare (lead_id, recipient_normalized) would mean
  -- migration 005 has not been applied.
  select pg_get_constraintdef(oid) into sequence_def
    from pg_constraint where conname = 'outreach_messages_sequence_key';
  if sequence_def !~ 'lead_id.*recipient_normalized.*sequence_number' then
    raise exception
      'outreach_messages_sequence_key is not (lead_id, recipient_normalized, sequence_number) — apply 20260101000500_outreach_sequence.sql';
  end if;
end
$$;

-- The parent-link trigger must exist. See the KNOWN DEFECT note at the top of
-- this file: its recipient half is currently inert, so this asserts presence,
-- not correctness.
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'outreach_messages'
      and t.tgname = 'outreach_messages_parent_same_lead'
      and not t.tgisinternal
  ) then
    raise exception
      'MISSING TRIGGER: outreach_messages_parent_same_lead — apply 20260101000500_outreach_sequence.sql';
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
    -- sequence lookups (replace outreach_messages_lead_recipient_key)
    'outreach_messages_sequence_key',
    'outreach_messages_sequence_idx',
    'outreach_messages_parent_idx',
    'outreach_messages_provider_id_idx',
    -- historical outreach lookups (migration 20260101000600)
    'historical_outreach_email_normalized_key',
    'historical_outreach_domain_idx',
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
      and tablename in (
        'leads', 'outreach_messages', 'action_tokens',
        'followup_notifications', 'historical_outreach'
      )
  loop
    raise exception
      'UNEXPECTED RLS POLICY %.% on public.% — PEPA is service-role only and needs no policies',
      p.schemaname, p.policyname, p.tablename;
  end loop;
end
$$;

-- Intentionally exactly as wide as migration
-- 20260101000400_revoke_public_grants.sql: ALL privileges, for BOTH anon and
-- authenticated, on ALL SIX PEPA objects — including the two views, which return
-- every lead's email address. A narrower check (write privileges on four tables
-- only) would pass even if SELECT had been re-granted on a view.
do $$
begin
  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'leads',
        'outreach_messages',
        'action_tokens',
        'followup_notifications',
        'historical_outreach',
        'outreach_overview',
        'due_followups'
      )
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception
      'anon/authenticated still holds a privilege on a PEPA object — the browser must never reach one';
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
-- 7. Historical outreach: the identity columns the guard reads are GENERATED
-- ---------------------------------------------------------------------------
-- If `email_normalized`, `domain_normalized` or `is_shared_provider` were
-- ordinary columns, the application could write a spelling that the guard's own
-- lookup would never find -- an address stored as `Info@Bistro.CZ` would stop
-- blocking `info@bistro.cz`. Generation is what keeps the TypeScript
-- normalization and the stored identity in agreement.
do $$
declare
  col text;
  generation text;
begin
  foreach col in array array['email_normalized', 'domain_normalized', 'is_shared_provider']
  loop
    select c.is_generated into generation
      from pg_attribute a
      join pg_class cls on cls.oid = a.attrelid
      join pg_namespace n on n.oid = cls.relnamespace
      join information_schema.columns c
        on c.table_schema = n.nspname and c.table_name = cls.relname and c.column_name = a.attname
     where n.nspname = 'public'
       and cls.relname = 'historical_outreach'
       and a.attname = col
       and a.attnum > 0
       and not a.attisdropped;

    if generation is distinct from 'ALWAYS' then
      raise exception
        'historical_outreach.% must be a GENERATED ALWAYS column, found % -- apply 20260101000600_historical_outreach.sql',
        col, coalesce(generation, 'nothing');
    end if;
  end loop;
end
$$;

-- The SQL mirrors must exist, because they are what the generated columns
-- evaluate. Naming them here turns a confusing error into a precise one.
do $$
declare
  fn text;
  arity int;
begin
  foreach fn in array array['normalize_domain', 'is_shared_email_provider']
  loop
    arity := 1;
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn and p.pronargs = arity
    ) then
      raise exception 'MISSING FUNCTION: public.%(text) -- apply 20260101000600_historical_outreach.sql', fn;
    end if;
  end loop;
end
$$;

-- SQL/TypeScript parity. `normalize_domain` and
-- `is_shared_email_provider` are mirrors of `src/lib/outreach/domain.ts`. A
-- drift between them is invisible in every other check here: the app would
-- decide with one function and the database would store with another, so an
-- identity could be blocked in one layer and missed in the other. These are the
-- exact spellings pinned by src/lib/outreach/domain.test.ts.
do $$
declare
  mismatched text;
begin
  select string_agg(input, ', ') into mismatched
    from unnest(array[
      '  Manihi.cz.  ',
      'HTTPS://WWW.Manihi.CZ/menu',
      '//www.Manihi.cz',
      'Manihi.cz:8443',
      'WWW.MANIHI.CZ',
      '<https://manihi.cz>'
    ]) as input
   where public.normalize_domain(input) is distinct from 'manihi.cz';

  if mismatched is not null then
    raise exception
      'public.normalize_domain disagrees with src/lib/outreach/domain.ts for: %', mismatched;
  end if;

  -- A value that is not a hostname must normalise to nothing, or a typo would
  -- become a phantom identity that blocks strangers.
  if public.normalize_domain('bistro') is not null then
    raise exception 'public.normalize_domain accepted a single-label value';
  end if;
  if public.normalize_domain('bistro..cz') is not null then
    raise exception 'public.normalize_domain accepted an empty label';
  end if;
  if public.normalize_domain('büstro.cz') is not null then
    raise exception 'public.normalize_domain accepted a non-ASCII label';
  end if;

  -- Mailboxes are not companies, and companies are not mailboxes.
  if public.is_shared_email_provider('seznam.cz') is not true then
    raise exception 'public.is_shared_email_provider does not recognise seznam.cz';
  end if;
  if public.is_shared_email_provider('seznamfirmy.cz') is not false then
    raise exception 'public.is_shared_email_provider wrongly treats seznamfirmy.cz as a provider';
  end if;
end
$$;

-- Every imported row must be labelled, and every provider domain must be
-- flagged. A row with another source would mean the column had started
-- meaning something the importer does not control; an unflagged gmail.com row
-- would mean the SQL mirror and src/lib/outreach/domain.ts had drifted apart,
-- which is exactly the drift that would let one business block another.
do $$
begin
  if exists (
    select 1 from public.historical_outreach where source <> 'historical_import'
  ) then
    raise exception
      'historical_outreach contains a row whose source is not ''historical_import''';
  end if;

  if exists (
    select 1 from public.historical_outreach
    where domain_normalized in ('gmail.com', 'seznam.cz', 'outlook.com')
      and is_shared_provider is not true
  ) then
    raise exception
      'public.is_shared_email_provider does not match src/lib/outreach/domain.ts -- shared providers are not flagged';
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