-- Fix `public.normalize_domain`: the dot-stripping call passed its flags as the
-- replacement string.
--
-- The defect:
--   `regexp_replace(value, '^\.+|\.+$', 'g')` has three arguments, and in
--   Postgres the third is the REPLACEMENT, not the flags. So every leading or
--   trailing dot was replaced with the literal letter "g":
--
--     select public.normalize_domain('  Manihi.cz.  ');  --  manihi.czg
--
--   The mirror in `src/lib/outreach/domain.ts` returns "manihi.cz" for the same
--   input. That is the drift this whole file exists to prevent: the application
--   decides with one function and the database stores with another, so an
--   address or domain could be blocked by the app and missed by a query, or the
--   reverse.
--
-- Why nothing is wrong with the imported data:
--   The export's `domain` column is already a bare lowercase hostname, so no
--   imported row has a leading or trailing dot and no stored value is affected.
--   This migration asserts that rather than assuming it, and repairs any row
--   that does disagree — cheap at 330 rows, and it keeps the migration honest if
--   it is ever replayed against a differently-shaped export.
--
-- Compatibility:
--   `create or replace` keeps the same signature, volatility and return type, so
--   the generated columns `domain_normalized` and `is_shared_provider` keep
--   working and no table is rewritten wholesale. No constraint, index, RLS
--   setting or grant changes.
--
-- Migration 00600 is corrected in place as well, so a database built from
-- scratch applies the right function the first time; this file is what repairs
-- the one that already ran.

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
  -- Fourth argument is the flags. The three-argument form appends the literal
  -- text instead of trimming, which is the bug this migration repairs.
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

-- Rewrite any stored value that the corrected expression disagrees with.
-- Postgres does not recompute a STORED generated column until the row is
-- touched, and redefining the underlying function is not such a touch.
update public.historical_outreach
   set domain = domain
 where domain_normalized is distinct from public.normalize_domain(domain);

-- Self-check. A migration that silently changed the identity function would be
-- worse than the bug it fixed, so the expected canonicalisations are asserted
-- here and in verify-schema.sql rather than trusted.
do $$
declare
  mismatched text;
begin
  select string_agg(input, ', ')
    into mismatched
    from unnest(array[
      '  Manihi.cz.  ',
      'HTTPS://WWW.Manihi.CZ/menu',
      '//www.Manihi.cz',
      'Manihi.cz:8443',
      'WWW.MANIHI.CZ'
    ]) as input
   where public.normalize_domain(input) is distinct from 'manihi.cz';

  if mismatched is not null then
    raise exception
      'public.normalize_domain still disagrees with src/lib/outreach/domain.ts for: %', mismatched;
  end if;

  -- `seznam.cz` is a mailbox; `seznamfirmy.cz` is a company. Conflating them
  -- would refuse outreach to unrelated businesses.
  if public.is_shared_email_provider('seznam.cz') is not true then
    raise exception 'public.is_shared_email_provider no longer recognises seznam.cz';
  end if;

  if public.is_shared_email_provider('seznamfirmy.cz') is not false then
    raise exception 'public.is_shared_email_provider wrongly treats seznamfirmy.cz as a provider';
  end if;
end
$$;