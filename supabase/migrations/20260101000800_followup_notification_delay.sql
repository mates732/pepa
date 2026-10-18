-- PEPA P8 — configurable follow-up Telegram notification delay.
--
-- Two additive changes:
--  1. `followup_notification_settings` — a singleton table holding the global
--     notification delay (value + unit). One row, created by the migration.
--  2. `leads.notification_due_at` — separate from `next_followup_at`, this is
--     when the Telegram notification becomes eligible. The email-due timestamp
--     (`next_followup_at`) is never touched by this migration.
--
-- Backwards compatibility:
--  * Existing leads get `notification_due_at = next_followup_at`, so the
--    notification fires at the same time as before (noBehaviour change).
--  * New leads get `notification_due_at` set by `markFollowUpSent()` when the
--    initial email is sent, computed as `sentAt + configuredDelay`.
--  * When `notification_due_at` is NULL (legacy, pre-migration), the engine
--    falls back to `next_followup_at` for notification eligibility.

-- ---------------------------------------------------------------------------
-- 1. followup_notification_settings
-- ---------------------------------------------------------------------------
create table public.followup_notification_settings (
  id uuid primary key default gen_random_uuid(),
  delay_value integer not null default 3,
  delay_unit text not null default 'minutes'
    check (delay_unit in ('seconds', 'minutes', 'hours', 'days')),
  updated_at timestamptz not null default now()
);

-- Exactly one row. Insert the default and prevent duplicates.
-- PostgreSQL forbids subqueries in index predicates, so the singleton is
-- enforced the standard way: a UNIQUE index on the constant expression `true`
-- permits at most one row, decided by the database rather than by application
-- logic alone.
insert into public.followup_notification_settings (id, delay_value, delay_unit)
values (gen_random_uuid(), 3, 'minutes')
on conflict do nothing;

-- Limit to a single row so the config is global, not per-tenant or per-user.
create unique index followup_notification_settings_one_row
  on public.followup_notification_settings ((true));

comment on table public.followup_notification_settings is
  'Global configurable delay for follow-up Telegram notifications. One row. NULL settings row means "use next_followup_at" (legacy behaviour).';

comment on column public.followup_notification_settings.delay_value is
  'Numeric delay value. Must be non-negative.';

comment on column public.followup_notification_settings.delay_unit is
  'Unit for the delay: seconds, minutes, hours, or days.';

alter table public.followup_notification_settings enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.followup_notification_settings from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.followup_notification_settings from authenticated';
  end if;
end
$$;

create trigger followup_notification_settings_touch_updated_at
  before update on public.followup_notification_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. leads.notification_due_at
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists notification_due_at timestamptz;

comment on column public.leads.notification_due_at is
  'When the Telegram follow-up notification becomes eligible. Set by markFollowUpSent() as sentAt + configuredDelay. NULL for pre-migration leads until they are rescheduled; the engine falls back to next_followup_at when NULL.';

create index leads_notification_due_idx
  on public.leads (notification_due_at)
  where notification_due_at is not null;

-- ---------------------------------------------------------------------------
-- 3. Backfill existing leads: notification_due_at = next_followup_at
-- ---------------------------------------------------------------------------
-- Preserve current behaviour: existing scheduled follow-ups keep notifying at
-- the same time they did before. New leads use the configured delay.
update public.leads
set notification_due_at = next_followup_at
where notification_due_at is null
  and next_followup_at is not null;
