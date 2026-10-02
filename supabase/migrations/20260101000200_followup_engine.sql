-- PEPA P2 — follow-up engine support.
--
-- Three objects, all additive. Nothing existing is dropped or rewritten.
--
--  1. `followup_notifications` — the durable idempotency ledger.
--  2. `due_followups`          — eligibility, evaluated in SQL on real timestamptz.
--  3. `outreach_overview`      — extended (CREATE OR REPLACE, new columns last).

-- ---------------------------------------------------------------------------
-- 1. followup_notifications
-- ---------------------------------------------------------------------------
-- One row per logical follow-up that has been claimed for notification.
--
-- Identity is (lead_id, followup_number), NOT (outreach_id, followup_number):
-- when the operator actually sends follow-up #1 a brand new outreach message is
-- created, which would change outreach_id and let the same follow-up notify
-- twice. lead_id + followup_number is stable for the lifetime of the lead
-- because followup_count only ever increases.
--
-- Lifecycle:
--   INSERT status='claimed'  -> token -> Telegram -> UPDATE status='sent'
--   Telegram failure         -> DELETE the row, so the next run retries
--   crash mid-flight         -> row stays 'claimed'; reclaimed after the lease
--
-- The unique constraint is the concurrency control: two schedulers racing on
-- the same follow-up, exactly one INSERT succeeds.
create table public.followup_notifications (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  outreach_id uuid references public.outreach_messages (id) on delete set null,
  followup_number integer not null,
  action_token_id uuid references public.action_tokens (id) on delete set null,
  status text not null default 'claimed',
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint followup_notifications_unique unique (lead_id, followup_number),
  constraint followup_notifications_status_check check (status in ('claimed', 'sent')),
  constraint followup_notifications_number_positive check (followup_number >= 1),
  constraint followup_notifications_sent_check check (
    status <> 'sent' or sent_at is not null
  )
);

comment on table public.followup_notifications is
  'Idempotency ledger for follow-up notifications. The unique (lead_id, followup_number) constraint is what prevents duplicate Telegram messages.';
comment on column public.followup_notifications.action_token_id is
  'Deep link minted for this notification, so the operator can reopen the exact follow-up.';

create index followup_notifications_lead_idx
  on public.followup_notifications (lead_id, followup_number desc);
create index followup_notifications_claimed_idx
  on public.followup_notifications (claimed_at)
  where status = 'claimed';

create trigger followup_notifications_touch_updated_at
  before update on public.followup_notifications
  for each row execute function public.touch_updated_at();

alter table public.followup_notifications enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.followup_notifications from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.followup_notifications from authenticated';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. due_followups
-- ---------------------------------------------------------------------------
-- Eligibility lives in SQL so every comparison is on real timestamptz values,
-- never on formatted strings, and never on browser-local time.
--
-- A lead is due when:
--   * it has a next_followup_at in the past;
--   * it is not replied / completed / blocked;
--   * it has at least one outreach message that actually went out and is not
--     itself replied / completed / blocked;
--   * followup_count is below the cadence maximum (applied in the service, which
--     owns the single source of truth for the cadence).
create or replace view public.due_followups
with (security_invoker = true) as
select
  l.id as lead_id,
  l.email,
  l.company_name,
  l.contact_name,
  l.status as lead_status,
  l.created_at,
  l.updated_at,
  l.last_contacted_at,
  l.next_followup_at,
  l.followup_count,
  m.id as outreach_id,
  m.recipient_email,
  m.subject,
  m.body,
  m.status as outreach_status,
  m.sent_at,
  m.created_at as outreach_created_at,
  (l.followup_count + 1) as followup_number
from public.leads l
join lateral (
  select mm.*
  from public.outreach_messages mm
  where mm.lead_id = l.id
    and mm.sent_at is not null
    and mm.status not in ('replied', 'completed', 'blocked')
  order by mm.created_at desc
  limit 1
) m on true
where l.next_followup_at is not null
  and l.next_followup_at <= now()
  and l.status not in ('replied', 'completed', 'blocked');

-- ---------------------------------------------------------------------------
-- 3. outreach_overview — extended with follow-up state
-- ---------------------------------------------------------------------------
-- New columns are appended, which CREATE OR REPLACE permits.
create or replace view public.outreach_overview
with (security_invoker = true) as
select
  l.id,
  l.email,
  l.email_normalized,
  l.company_name,
  l.contact_name,
  l.status,
  l.created_at,
  l.updated_at,
  l.last_contacted_at,
  l.next_followup_at,
  l.followup_count,
  latest.subject as latest_subject,
  latest.status as latest_message_status,
  latest.created_at as latest_message_at,
  coalesce(counts.message_count, 0) as message_count,
  notified.last_followup_number as last_followup_notified_number,
  notified.last_followup_notified_at as last_followup_notified_at
from public.leads l
left join lateral (
  select m.subject, m.status, m.created_at
  from public.outreach_messages m
  where m.lead_id = l.id
  order by m.created_at desc
  limit 1
) latest on true
left join lateral (
  select count(*)::int as message_count
  from public.outreach_messages m2
  where m2.lead_id = l.id
) counts on true
left join lateral (
  select
    fn.followup_number as last_followup_number,
    fn.sent_at as last_followup_notified_at
  from public.followup_notifications fn
  where fn.lead_id = l.id and fn.status = 'sent'
  order by fn.followup_number desc
  limit 1
) notified on true;