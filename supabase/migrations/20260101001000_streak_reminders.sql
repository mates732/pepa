-- PEPA — the 19:00 streak reminder ledger.
--
-- The streak itself stays derived (never stored — see outreach-streak-service).
-- The ONE thing stored here is the fact that a reminder was delivered for a
-- calendar day: the evening scheduler runs several times (see the cron
-- schedules), and a day must be reminded exactly once, never twice.
--
-- Claimed-then-sent, the same two-step the follow-up engine uses on
-- `followup_notifications`:
--   * INSERT the claim — the PRIMARY KEY is the idempotency, decided by
--     Postgres rather than by a JS mutex, so concurrent runs cannot both win;
--   * on a Telegram failure the claim is deleted, so a later run the same
--     evening retries — a failure is never recorded as a reminder.
--
-- `day_key` is the operator's calendar day (`YYYY-MM-DD`, Europe/Prague) as
-- text, so the ledger agrees byte for byte with the day keys the streak
-- arithmetic already uses — no cast, no zone reinterpretation in SQL.

create table public.streak_reminders (
  day_key text primary key,
  status text not null default 'claimed'
    check (status in ('claimed', 'sent')),
  -- Length of the consecutive run the reminder was about, as sent: the run
  -- ending the previous day. 0 means nothing was at risk.
  streak_days integer not null default 0 check (streak_days >= 0),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  -- A delivered reminder is a dated fact, so its timestamp is not optional
  -- once the row says 'sent'. A claim still in flight has none.
  constraint streak_reminders_sent_at_check check (
    status <> 'sent' or sent_at is not null
  )
);

comment on table public.streak_reminders is
  'One row per calendar day the streak reminder ran for. The primary key is the once-per-day guarantee: a second run finds the row and stays silent.';

comment on column public.streak_reminders.day_key is
  'The operator''s calendar day as YYYY-MM-DD in Europe/Prague. Primary key: at most one reminder per day.';

comment on column public.streak_reminders.status is
  'claimed = a run took ownership and may still be delivering; sent = the Telegram message went out.';

comment on column public.streak_reminders.streak_days is
  'Length of the consecutive active-day run the reminder reported as at risk.';

alter table public.streak_reminders enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.streak_reminders from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.streak_reminders from authenticated';
  end if;
end
$$;
