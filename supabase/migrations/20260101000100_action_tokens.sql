-- PEPA P1 — secure deep-link action tokens.
--
-- Purpose: Telegram carries an opaque, single-purpose reference to a PEPA
-- resource. The raw token is NEVER stored — only an HMAC-SHA256 digest — so a
-- database leak cannot be replayed as a deep link.
--
-- Design decisions:
--  * `token_hash` is unique and indexed; lookups are by digest only.
--  * `purpose` scopes the token: a follow-up token can never open anything else.
--  * `expires_at` is mandatory. Short-lived by default.
--  * `used_at` records first use for auditing. Tokens stay re-openable within
--    their TTL so a mobile user can refresh, share or re-tap the button; only
--    rotating PEPA_SESSION_SECRET-style expiry or deleting the row revokes them.
--  * `lead_id` is a foreign key, never encoded into the token, so a token can
--    never be used to enumerate leads.

create table public.action_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  purpose text not null,
  lead_id uuid not null references public.leads (id) on delete cascade,
  outreach_id uuid references public.outreach_messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint action_tokens_purpose_check
    check (purpose in ('followup_composer'))
);

comment on table public.action_tokens is
  'Opaque deep-link references for Telegram. Only HMAC digests are stored; the raw token lives in the Telegram button URL.';

comment on column public.action_tokens.token_hash is
  'HMAC-SHA256(raw token) with domain separation. Never the raw token.';

comment on column public.action_tokens.used_at is
  'First-use timestamp for auditing. Does not invalidate the token.';

-- Housekeeping: the follow-up engine (a later task) sweeps expired rows.
create index action_tokens_expires_at_idx on public.action_tokens (expires_at);
create index action_tokens_lead_idx on public.action_tokens (lead_id, created_at desc);

-- Same posture as the rest of PEPA: unreachable from the browser.
alter table public.action_tokens enable row level security;

-- Belt and braces: no grants either, where the Supabase roles exist. Wrapped in
-- a guard so the migration still applies to a plain Postgres instance.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.action_tokens from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.action_tokens from authenticated';
  end if;
end
$$;