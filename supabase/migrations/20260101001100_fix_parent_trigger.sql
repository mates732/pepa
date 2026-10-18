-- Fix the parent-link trigger: recipient_normalized is GENERATED and not yet
-- available in a BEFORE trigger. Use recipient_email and normalize inline.
--
-- The original trigger (migration 20260101000500) checked
-- `NEW.recipient_normalized` against the parent's `recipient_normalized`.
-- Since generated columns are evaluated AFTER before-row triggers, that value
-- was NULL and the recipient half of the check never fired.
--
-- This migration replaces the trigger function with one that normalizes
-- NEW.recipient_email on the fly using the same public.normalize_email function.

create or replace function public.outreach_messages_parent_same_lead()
returns trigger
language plpgsql
as $$
declare
  parent_lead uuid;
  parent_recipient text;
  new_recipient_normalized text;
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

  -- recipient_normalized is GENERATED; compute it from recipient_email here.
  new_recipient_normalized := public.normalize_email(new.recipient_email);
  if parent_recipient <> new_recipient_normalized then
    raise exception 'outreach_messages: parent_message_id must have the same recipient';
  end if;

  return new;
end;
$$;

-- Re-create the trigger with the fixed function.
drop trigger if exists outreach_messages_parent_same_lead on public.outreach_messages;
create trigger outreach_messages_parent_same_lead
  before insert or update on public.outreach_messages
  for each row execute function public.outreach_messages_parent_same_lead();

-- Self-check: verify the function body uses normalize_email.
do $$
declare
  fn_body text;
begin
  select prosrc into fn_body
  from pg_proc
  where proname = 'outreach_messages_parent_same_lead'
    and pronamespace = 'public'::regnamespace;
  if fn_body !~ 'normalize_email' then
    raise exception 'trigger function does not call normalize_email';
  end if;
end
$$;