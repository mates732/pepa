-- Outreach tool — durable outreach sequence (Initial -> Follow-up #1 -> #2 -> ...)
--
-- Why this exists:
--   `outreach_messages` carried `unique (lead_id, recipient_normalized)`, which
--   allowed exactly ONE message row per lead/recipient. A follow-up therefore
--   had nowhere to live. `leads.followup_count` was only a counter: it recorded
--   *how many* follow-ups went out, never *which message* each one was, and it
--   carried no subject, body, recipient or sent_at. `saveFollowUpDraft()` closed
--   the gap by overwriting the initial outreach's subject and body in place,
--   destroying the only historical record of what was originally sent.
--
--   `due_followups` worked around this by re-anchoring on "the latest sent
--   message" (`order by created_at desc limit 1`). That is fine for deciding
--   *whether* to notify, but it is an inference, not a relationship: it cannot
--   say which follow-up belongs to which original outreach, and it silently
--   mislabels history once more than one row exists per lead.
--
-- What this adds:
--   sequence_number   0 = initial outreach, 1 = follow-up #1, 2 = follow-up #2.
--   parent_message_id the explicit predecessor link, forming a real chain.
--
--   Together these make the sequence answerable from the database alone, with no
--   counter arithmetic and no UI inference. No new table: `outreach_messages`
--   remains the single canonical outreach history.
--
-- Existing data:
--   Every existing row is, by construction, an initial outreach — the schema
--   permitted nothing else. They all receive sequence_number = 0 and
--   parent_message_id = NULL. Nothing is inserted, rewritten or invented:
--   `leads.followup_count = 2` still means "two follow-ups went out", but those
--   two emails were never stored as rows and cannot be reconstructed. This
--   migration only grants the ability to represent *future* follow-ups
--   truthfully. Backfilling them would fabricate history, which is exactly what
--   this phase exists to prevent.
--
-- Compatibility:
--   * No column is dropped or retyped; id, lead_id, recipient_email, subject,
--     body, status, created_at, sent_at, provider and provider_message_id are
--     untouched.
--   * The old constraint is replaced, not merely dropped: uniqueness is still
--     enforced, now per sequence slot.
--   * `leads.followup_count` and `leads.next_followup_at` are deliberately left
--     alone. They remain the scheduling/notification clock, and this phase does
--     not change their behaviour.
--   * `due_followups` and `outreach_overview` keep their external contracts.
--     `outreach_overview.message_count` now counts sequence rows, which is the
--     accurate answer to "how many emails went to this lead".

-- ------------------------------------------------------------------
-- 1. sequence_number
-- ------------------------------------------------------------------
-- NOT NULL DEFAULT 0 so every existing row becomes an initial outreach without
-- a rewrite pass, and so an insert that forgets the column still produces a
-- valid initial outreach rather than a NULL that breaks ordering.
alter table public.outreach_messages
  add column if not exists sequence_number smallint not null default 0;

comment on column public.outreach_messages.sequence_number is
  'Position in the lead''s outreach sequence: 0 = initial outreach, 1 = follow-up #1, 2 = follow-up #2. Unique per (lead_id, recipient_normalized).';

-- A negative slot has no meaning and would break "max(sequence_number) + 1".
alter table public.outreach_messages
  drop constraint if exists outreach_messages_sequence_number_nonnegative;
alter table public.outreach_messages
  add constraint outreach_messages_sequence_number_nonnegative
  check (sequence_number >= 0);

-- ------------------------------------------------------------------
-- 2. parent_message_id
-- ------------------------------------------------------------------
-- NULL for an initial outreach; the predecessor's id for a follow-up. ON DELETE
-- SET NULL rather than CASCADE: deleting an intermediate message must not
-- silently delete the follow-ups recorded after it. The rows survive and simply
-- re-root, which keeps the audit trail intact. That is why the CHECK constraint
-- below is one-directional.
alter table public.outreach_messages
  add column if not exists parent_message_id uuid
    references public.outreach_messages (id) on delete set null;

comment on column public.outreach_messages.parent_message_id is
  'The message this one follows. NULL for an initial outreach. ON DELETE SET NULL so deleting an ancestor never deletes recorded follow-ups.';

-- A row that names a parent is a follow-up, so it cannot sit at slot 0. This is
-- deliberately one-directional rather than "slot 0 <=> no parent":
-- `parent_message_id` is ON DELETE SET NULL, so deleting an intermediate message
-- leaves its surviving follow-up as an orphan with a NULL parent. Requiring the
-- converse would make that deletion fail outright and would push the choice
-- towards ON DELETE CASCADE, which silently destroys recorded outreach. Losing
-- the ability to re-root a chain is strictly better than losing the emails, so
-- an orphaned follow-up is permitted and simply has no predecessor.
-- Both names are dropped so a re-run of this file is a no-op rather than an
-- error: `outreach_messages_parent_consistent` was the stricter, two-way
-- version this constraint replaced.
alter table public.outreach_messages
  drop constraint if exists outreach_messages_parent_consistent;
alter table public.outreach_messages
  drop constraint if exists outreach_messages_parent_is_followup;
alter table public.outreach_messages
  add constraint outreach_messages_parent_is_followup
  check (parent_message_id is null or sequence_number > 0);

-- A parent must belong to the same lead and the same recipient as its child.
-- Otherwise a crafted write could graft a follow-up from lead A onto lead B's
-- sequence. Subqueries are not allowed in CHECK, so this is a trigger.
create or replace function public.outreach_messages_parent_same_lead()
returns trigger
language plpgsql
as $$
declare
  parent_lead uuid;
  parent_recipient text;
begin
  if new.parent_message_id is null then
    return new;
  end if;

  if new.parent_message_id = new.id then
    raise exception 'outreach_messages: a message cannot be its own parent';
  end if;

  select lead_id, recipient_normalized
    into parent_lead, parent_recipient
    from public.outreach_messages
   where id = new.parent_message_id;

  if parent_lead is null then
    -- The parent vanished between the write and this trigger (concurrent
    -- delete). ON DELETE SET NULL makes that recoverable, so accept the write.
    return new;
  end if;

  if parent_lead <> new.lead_id then
    raise exception 'outreach_messages: parent_message_id must belong to the same lead';
  end if;

  if parent_recipient <> new.recipient_normalized then
    raise exception 'outreach_messages: parent_message_id must have the same recipient';
  end if;

  return new;
end;
$$;

drop trigger if exists outreach_messages_parent_same_lead on public.outreach_messages;
create trigger outreach_messages_parent_same_lead
  before insert or update on public.outreach_messages
  for each row execute function public.outreach_messages_parent_same_lead();

-- ------------------------------------------------------------------
-- 3. uniqueness — replaced, not removed
-- ------------------------------------------------------------------
-- The old rule made a second row for one lead/recipient impossible. The new
-- rule allows 0, 1, 2, ... while still refusing two *different* messages
-- claiming the same slot for the same lead and recipient.
--
-- Uniqueness is therefore replaced, never merely removed.
--
-- This builds a fresh unique index, which Postgres always scans, so it cannot be
-- added `not valid` (that form exists for CHECK and FOREIGN KEY only). That is
-- safe here: the table is small, and no existing row can collide. Every existing
-- row is sequence_number = 0, and `outreach_messages_lead_recipient_key` was
-- still in force up to this statement, so those rows were already unique per
-- (lead_id, recipient_normalized) and remain unique with 0 appended.
--
-- Dropped only after the replacement is in place, so there is never a moment
-- where duplicate rows are permitted.
alter table public.outreach_messages
  drop constraint if exists outreach_messages_sequence_key;
alter table public.outreach_messages
  add constraint outreach_messages_sequence_key
  unique (lead_id, recipient_normalized, sequence_number);

alter table public.outreach_messages
  drop constraint if exists outreach_messages_lead_recipient_key;

comment on constraint outreach_messages_sequence_key on public.outreach_messages is
  'One message per sequence slot per lead/recipient. Replaces outreach_messages_lead_recipient_key, which allowed only one row per lead/recipient and left follow-ups nowhere to live.';

-- ------------------------------------------------------------------
-- 4. indexes
-- ------------------------------------------------------------------
-- outreach_messages_lead_idx is (lead_id, created_at desc). It cannot serve
-- "the latest row in this sequence" ordering, because sequence order and
-- creation order are not the same thing once a follow-up is created later.
create index if not exists outreach_messages_sequence_idx
  on public.outreach_messages (lead_id, recipient_normalized, sequence_number desc);

-- Walking the chain backwards ("what did this follow up?") is a parent lookup.
-- Partial: only follow-ups have a parent, so the index stays small.
create index if not exists outreach_messages_parent_idx
  on public.outreach_messages (parent_message_id)
  where parent_message_id is not null;

-- ------------------------------------------------------------------
-- 5. due_followups — anchor the follow-up on the sequence, not on a guess
-- ------------------------------------------------------------------
-- The view picks the message a follow-up hangs off, and it did so with
-- `order by created_at desc limit 1`. That was unambiguous when a lead had
-- exactly one message. Now that a lead can hold several, "newest by wall clock"
-- is the wrong key: creation time records when a row was written, not where it
-- sits in the conversation. A follow-up drafted later but belonging to an
-- earlier point in the sequence would win that comparison.
--
-- `sequence_number` is the canonical order, so it now leads the ordering, with
-- created_at kept only as a stable tie-break for rows sharing a slot (which the
-- unique index makes impossible within one lead/recipient, but can happen across
-- two recipients of the same lead).
--
-- The view's external contract is unchanged: same columns, same eligibility
-- rules, same `followup_number` derivation from `leads.followup_count`. Only the
-- anchor ordering becomes explicit. `sequence_number` is appended, which
-- CREATE OR REPLACE permits and which existing readers ignore because they
-- select an explicit column list.
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
  (l.followup_count + 1) as followup_number,
  m.sequence_number as anchor_sequence_number
from public.leads l
join lateral (
  select mm.*
  from public.outreach_messages mm
  where mm.lead_id = l.id
    and mm.sent_at is not null
    and mm.status not in ('replied', 'completed', 'blocked')
  order by mm.sequence_number desc, mm.created_at desc
  limit 1
) m on true
where l.next_followup_at is not null
  and l.next_followup_at <= now()
  and l.status not in ('replied', 'completed', 'blocked');

-- ------------------------------------------------------------------
-- 6. grants
-- ------------------------------------------------------------------
-- anon/authenticated have no privileges on this table and RLS stays enabled
-- with zero policies. The revoke is idempotent belt-and-braces so this table
-- cannot accidentally reintroduce the browser-facing grants that
-- 20260101000400_revoke_public_grants.sql removed.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.outreach_messages from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.outreach_messages from authenticated';
  end if;
end
$$;
