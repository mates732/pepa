-- Historical outreach — imported legacy cold outreach from the previous business account.
--
-- Why this exists:
--   PEPA's `outreach_messages` table is the canonical outreach history, and it
--   models *individual emails*: one row per message, `sent_at` NOT NULL whenever
--   `status = 'sent'`, and a UNIQUE (lead_id, recipient_normalized,
--   sequence_number) key. The legacy export
--   (`pepa_outreach_history_detailed.csv`) is not that. It is an AGGREGATE per
--   address: contact_count, first_contact, last_contact and a de-duplicated list
--   of subject lines. contact_count does not equal the number of subjects
--   (300 of 330 rows differ, and one address has 143 contacts), and the export
--   carries no per-message timestamp, no lead id, no sequence number and no
--   provider message id.
--
--   So the aggregate cannot be represented truthfully as message rows. Writing
--   one row per subject would require inventing a `sent_at` per row, and writing
--   one row per address would both lose the subject list and occupy sequence
--   slot 0 — the slot the composer upserts into — so saving a draft would
--   silently overwrite imported history. Both fabrications are refused.
--
-- What this adds:
--   `historical_outreach` — one row per normalized address, holding the imported
--   identity and the aggregate counts exactly as exported. It is not a parallel
--   send path: `outreach_messages` remains the only place a real message is
--   recorded, and this table can never be written by the application except
--   through the idempotent import.
--
-- How it protects sends:
--   `evaluateStoredMessageQualityGate()` consults this table inside the send
--   transition and refuses a NEW cold outreach (sequence_number = 0) to an
--   address that is already on record here. Follow-ups inside a Pepa sequence
--   are governed by the existing finite cooldown, so the guard is permanent for
--   first contact and finite for subsequent contact, exactly as the product's
--   cadence intends.
--
--   The address is the primary identity (`email_normalized`). `domain` is a
--   secondary guard only, and never for a shared mailbox provider: the
--   generated `is_shared_provider` column exists so `gmail.com` rows cannot
--   participate in a domain-level block even if a caller forgets to check.
--
-- Existing data:
--   Nothing is inserted, rewritten or deleted. `leads` and `outreach_messages`
--   are untouched — the import sets `leads.last_contacted_at` separately, and
--   only for addresses that are already leads.
--
-- CORRECTION: the `normalize_domain` body below originally wrote
-- `regexp_replace(value, '^\.+|\.+$', 'g')`, whose third argument is the
-- REPLACEMENT in Postgres rather than the flags, so a leading or trailing dot
-- became the letter "g" and the SQL stopped agreeing with
-- `src/lib/outreach/domain.ts`. No imported row was affected — the export's
-- domain column is already a bare hostname — and
-- `20260101000700_fix_normalize_domain_flags.sql` repairs the live database. The
-- line is fixed here so a from-scratch build never carries the defect.

-- ---------------------------------------------------------------------------
-- 1. shared normalisation (mirrors src/lib/outreach/domain.ts)
-- ---------------------------------------------------------------------------
-- Same character class as public.normalize_email in spirit, but for hostnames:
-- a domain is never a path, a port or a userinfo section, and a value that is
-- not a hostname returns NULL rather than a phantom identity.
create or replace function public.normalize_domain(raw text)
returns text
language plpgsql
immutable
strict
parallel safe
as $$
declare
  value text;
begin
  value := lower(btrim(coalesce(raw, '')));
  if value = '' then
    return null;
  end if;

  value := regexp_replace(value, '^[<]+', '');
  value := regexp_replace(value, '[>]+$', '');
  value := regexp_replace(value, '^[a-z][a-z0-9+.-]*://', '');
  value := regexp_replace(value, '^//', '');
  value := regexp_replace(value, '^[^@/]*@', '');
  value := split_part(value, '/', 1);
  value := split_part(value, '?', 1);
  value := split_part(value, '#', 1);
  value := regexp_replace(value, ':\d+$', '');
  value := regexp_replace(value, '^[.]+|[.]+$', '', 'g');
  value := regexp_replace(value, '^www\.', '');

  if value is null or value = '' or length(value) > 253 then
    return null;
  end if;

  if value !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    return null;
  end if;

  return value;
end;
$$;

comment on function public.normalize_domain(text) is
  'Mirror of normalizeDomain() in src/lib/outreach/domain.ts. Used for the secondary, company-level identity guard.';

-- ---------------------------------------------------------------------------
-- 2. shared mailbox providers (mirrors SHARED_EMAIL_PROVIDER_DOMAINS)
-- ---------------------------------------------------------------------------
-- A gmail.com address belongs to a person, not to a company. Returning true
-- here makes a domain-level block structurally impossible for those rows
-- rather than a convention a future caller has to remember.
create or replace function public.is_shared_email_provider(raw text)
returns boolean
language sql
immutable
strict
parallel safe
as $$
  select
    d = any (array[
      'gmail.com', 'googlemail.com',
      'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
      'passport.com', 'windowslive.com',
      'yahoo.com', 'ymail.com', 'rocketmail.com',
      'icloud.com', 'me.com', 'mac.com',
      'aol.com',
      'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch',
      'web.de', 'mail.com', 'mail.ru',
      'yandex.ru', 'yandex.com',
      'zoho.com',
      'protonmail.com', 'proton.me', 'pm.me',
      'fastmail.com', 'tutanota.com', 'tuta.io',
      'hushmail.com', 'inbox.com',
      'qq.com', '163.com', '126.com', 'naver.com',
      'seznam.cz', 'centrum.cz', 'volny.cz', 'at.cz',
      'tiscali.cz', 'o2.cz', 'internet.cz', 'email.cz',
      'freemail.cz', 'posluch.net'
    ])
    or d like 'yahoo.%'
    or d like 'ymail.%'
    or d like 'gmx.%'
    or d like 'hotmail.%'
    or d like 'outlook.%'
    or d like 'live.%'
    or d like 'yandex.%'
    or d like 'protonmail.%'
  from (select public.normalize_domain(raw) as d) s
  where d is not null;
$$;

comment on function public.is_shared_email_provider(text) is
  'True when the domain is a public mailbox provider. Such a domain must never trigger a domain-level contact block.';

-- ---------------------------------------------------------------------------
-- 3. the table
-- ---------------------------------------------------------------------------
create table if not exists public.historical_outreach (
  id uuid primary key default gen_random_uuid(),
  -- The address exactly as the export spelled it. `email_normalized` below is
  -- the identity; this column is only what a human reads.
  email text not null,
  company text,
  domain text not null,
  -- How many times the legacy account emailed this address. Aggregate, as
  -- exported: it is NOT the number of rows here, and deliberately does not
  -- pretend to be a message count.
  contact_count integer not null default 1,
  first_contact_at timestamptz not null,
  last_contact_at timestamptz not null,
  -- De-duplicated subject lines, joined exactly as the export joined them.
  subjects text,
  -- Every row in this table comes from the legacy export. The CHECK pins that,
  -- so the column cannot silently start meaning something else later.
  source text not null default 'historical_import',
  imported_at timestamptz not null default now(),
  email_normalized text generated always as (public.normalize_email(email)) stored,
  domain_normalized text generated always as (public.normalize_domain(domain)) stored,
  is_shared_provider boolean generated always as (
    public.is_shared_email_provider(domain)
  ) stored,
  constraint historical_outreach_contact_count_positive check (contact_count >= 1),
  constraint historical_outreach_window_ordered check (last_contact_at >= first_contact_at),
  constraint historical_outreach_source_check check (source in ('historical_import'))
);

comment on table public.historical_outreach is
  'Imported legacy outreach, one row per normalized address. Aggregate by nature: no per-message rows are fabricated.';

comment on column public.historical_outreach.source is
  'Always ''historical_import''. Distinguishes imported legacy history from Pep-generated outreach in outreach_messages.';

comment on column public.historical_outreach.contact_count is
  'Number of legacy emails to this address, as exported. An aggregate fact about the export, not a row count and not a follow-up tally.';

comment on column public.historical_outreach.email_normalized is
  'Generated by public.normalize_email, mirroring src/lib/email.ts. The canonical identity for this table.';

comment on column public.historical_outreach.is_shared_provider is
  'Generated. True for gmail.com, seznam.cz, outlook.com and every other public mailbox, so those rows cannot drive a domain-level block.';

-- ---------------------------------------------------------------------------
-- 4. uniqueness — the import must be idempotent
-- ---------------------------------------------------------------------------
-- UNIQUE on the canonical address is the whole dedupe guarantee, and it is the
-- right shape here rather than a compromise:
--
--   * Running the import twice cannot produce a second row, because the second
--     run collides on the canonical address. The importer also sends
--     `ignoreDuplicates`, so a re-run is a no-op rather than an error.
--   * It does NOT restrict legitimate multiple outreach events. That
--     constraint lives in `outreach_messages`
--     (lead_id, recipient_normalized, sequence_number), which this migration
--     does not touch. Historical *events* are represented by `contact_count` on
--     the single aggregate row; historical *messages* were never exported and
--     are not invented.
--
-- Added as a constraint rather than an index so it is enforced for every
-- writer, including a future one, and so `verify-schema.sql` can assert it by
-- name the way it already asserts `outreach_messages_sequence_key`.
alter table public.historical_outreach
  drop constraint if exists historical_outreach_email_normalized_key;
alter table public.historical_outreach
  add constraint historical_outreach_email_normalized_key unique (email_normalized);

-- ---------------------------------------------------------------------------
-- 5. indexes
-- ---------------------------------------------------------------------------
-- The company-level guard looks a domain up and wants the most recent contact.
create index if not exists historical_outreach_domain_idx
  on public.historical_outreach (domain_normalized, last_contact_at desc);

-- A blank address must not create a phantom identity, exactly as
-- leads.email_not_blank does for leads.
alter table public.historical_outreach
  drop constraint if exists historical_outreach_email_not_blank;
alter table public.historical_outreach
  add constraint historical_outreach_email_not_blank
  check (length(public.normalize_email(email)) > 3);

-- ---------------------------------------------------------------------------
-- 6. row level security
-- ---------------------------------------------------------------------------
-- Same posture as every other PEPA table: RLS on, zero policies, and no browser
-- grants. `getSupabaseAdmin()` uses the service role and bypasses both.
alter table public.historical_outreach enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.historical_outreach from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.historical_outreach from authenticated';
  end if;
end
$$;