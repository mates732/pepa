-- PEPA P8 — notify when the follow-up is actually due.
--
-- The operator's requirement: marking an outreach as sent starts a timer (4
-- business days for follow-up #1, per the cadence), and when that timer expires
-- the Telegram bot writes that the follow-up should go out, with a deep link to
-- it. The engine already did all of that — except the notification was
-- anchored on the wrong end: `notification_due_at` was computed as
-- `sentAt + configuredDelay`, so with the default 3-minute delay the bot wrote
-- minutes after the send instead of when the follow-up came due.
--
-- This migration re-anchors the configuration on the due moment:
--  1. the settings default becomes 0 (notify exactly on time);
--  2. every already-scheduled follow-up that has NOT been notified yet is moved
--     to its due moment, so the next scheduler pass writes at the right time.
-- Already-delivered notifications are never touched, and `next_followup_at` —
-- the email-due timestamp — is not modified at all.

-- ---------------------------------------------------------------------------
-- 1. Settings default: 0 = notify exactly when the follow-up is due
-- ---------------------------------------------------------------------------
alter table public.followup_notification_settings
  alter column delay_value set default 0;

-- Move the singleton row to the new default. The operator may tune it in the
-- Follow-ups workspace afterwards (the value is an offset from the due moment,
-- never from the send).
update public.followup_notification_settings
set delay_value = 0,
    delay_unit = 'minutes'
where delay_value <> 0
   or delay_unit <> 'minutes';

comment on column public.followup_notification_settings.delay_value is
  'Offset added to the follow-up due moment. 0 = notify exactly on time; a positive value is a late reminder. Never negative.';

comment on column public.followup_notification_settings.delay_unit is
  'Unit for the offset from the follow-up due moment: seconds, minutes, hours, or days.';

comment on table public.followup_notification_settings is
  'Global configurable offset for follow-up Telegram notifications. One row. The offset is added to next_followup_at, so 0 notifies when the follow-up becomes due.';

-- ---------------------------------------------------------------------------
-- 2. Re-anchor not-yet-notified schedules on the due moment
-- ---------------------------------------------------------------------------
-- `notification_due_at` written under the old (send-anchored) semantics is
-- either already in the past — the bot wrote early or will on the next pass —
-- or shifted relative to the due time. Any lead whose next follow-up has NOT
-- been delivered yet (no `sent` ledger row for followup_count + 1) is moved to
-- notify exactly when the email comes due. Delivered ones keep their record:
-- the ledger is the audit surface and is never rewritten.
update public.leads l
set notification_due_at = l.next_followup_at
where l.notification_due_at is not null
  and l.next_followup_at is not null
  and l.notification_due_at <> l.next_followup_at
  and not exists (
    select 1
    from public.followup_notifications n
    where n.lead_id = l.id
      and n.followup_number = l.followup_count + 1
      and n.status = 'sent'
  );

comment on column public.leads.notification_due_at is
  'When the Telegram follow-up notification becomes eligible. Set by markFollowUpSent() as the cadence due moment (next_followup_at) + the configured offset, so the default 0 notifies when the follow-up is due. NULL for pre-migration leads until they are rescheduled; the engine falls back to next_followup_at when NULL.';
