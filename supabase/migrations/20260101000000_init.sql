-- Outreach tool — initial schema
--
-- Design notes:
--  * Duplicate detection is enforced by the database, not the frontend.
--  * `leads.email_normalized` is a generated column computed by the immutable
--    function `public.normalize_email`. The unique index sits on that column,
--    so `Info@Example.com`, `"info@example.com"` and ` info@example.com ` can
--    never produce two lead rows.
--  * The SQL function is mirrored in TypeScript at `src/lib/email.ts`. Change
--    one, change the other.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- shared normalisation
-- ---------------------------------------------------------------------------
create or replace function public.normalize_email(raw text)
returns text
language sql
immutable
strict
parallel safe
as $$
  -- Mirrors extractAddress() then normalizeEmail() in src/lib/email.ts.
  select lower(
    regexp_replace(
      btrim(coalesce(substring(btrim(raw) from '<([^<>]+)>'), btrim(raw))),
      '(^[^A-Za-z0-9._%+/-]+)|([^A-Za-z0-9._%+/-]+$)',
      '',
      'g'
    )
  );
$$;

comment on function public.normalize_email(text) is
  'Mirror of normalizeEmail() in src/lib/email.ts. Used for duplicate detection.';

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------
create type public.outreach_status as enum (
  'draft',
  'ready',
  'sent',
  'replied',
  'follow_up',
  'completed',
  'blocked'
);

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  company_name text,
  contact_name text,
  status public.outreach_status not null default 'ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_contacted_at timestamptz,
  next_followup_at timestamptz,
  followup_count integer not null default 0,
  email_normalized text generated always as (public.normalize_email(email)) stored,
  constraint leads_email_normalized_key unique (email_normalized),
  constraint leads_email_not_blank check (length(public.normalize_email(email)) > 3),
  constraint leads_followup_count_positive check (followup_count >= 0)
);

comment on column public.leads.email_normalized is
  'Generated, never written by the app. The unique index on this column is the dedupe guarantee.';

create index leads_status_idx on public.leads (status);
-- Index used by the follow-up engine (V2): "what is due today?".
create index leads_next_followup_idx on public.leads (next_followup_at)
  where next_followup_at is not null;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- outreach_messages
-- ---------------------------------------------------------------------------
create table public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  recipient_email text not null,
  subject text,
  body text,
  status public.outreach_status not null default 'draft',
  -- Filled in by the sending service once a provider is wired up (V2).
  provider text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  recipient_normalized text generated always as (public.normalize_email(recipient_email)) stored,
  constraint outreach_messages_lead_recipient_key unique (lead_id, recipient_normalized),
  constraint outreach_messages_sent_at_status_check check (
    status <> 'sent' or sent_at is not null
  )
);

create index outreach_messages_lead_idx on public.outreach_messages (lead_id, created_at desc);
create index outreach_messages_status_idx on public.outreach_messages (status);
-- Reply detection (V2): match a provider message id without a full scan.
create unique index outreach_messages_provider_id_idx
  on public.outreach_messages (provider, provider_message_id)
  where provider_message_id is not null;

comment on column public.outreach_messages.provider is
  'Provider id from EmailProvider (gmail, apple_mail, ...). Null until actually sent.';

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------
-- This is a single-user internal tool. Every read and write goes through
-- server-side code using the service-role key, which bypasses RLS. No anon or
-- authenticated policy is granted, so the data is unreachable from the browser.
-- When authentication is added, add policies for the authenticated role here.
alter table public.leads enable row level security;
alter table public.outreach_messages enable row level security;

-- ---------------------------------------------------------------------------
-- reporting helper for the dashboard table
-- ---------------------------------------------------------------------------
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
  coalesce(counts.message_count, 0) as message_count
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
) counts on true;