-- Read-only verification of the outreach sequence model.
--
-- Purpose: requirement "inspect existing outreach records before changing
-- schema or queries". No migration is needed — `sequence_number`,
-- `parent_message_id` and the UNIQUE (lead_id, recipient_normalized,
-- sequence_number) index already carry the initial/follow-up distinction, and
-- every creation path (`createOutreachWithFollowUps`, `createFollowUpDraft`)
-- writes `sequence_number` explicitly. This script inspects the data that
-- relies on that model and REPORTS rows that cannot be classified safely,
-- instead of guessing. Nothing here writes: every statement is a SELECT.
--
-- Run in the Supabase SQL editor against the target project. A clean run
-- returns zero rows in every "manual review" section.

-- 1. Shape of the data: one row per classification.
select
  case when sequence_number = 0 then 'initial' else 'follow-up' end as kind,
  status,
  count(*) as rows
from outreach_messages
group by 1, 2
order by 1, 2;

-- 2. MANUAL REVIEW: follow-up rows whose sequence-0 sibling (same lead +
--    recipient) does not exist. The association cannot be reconstructed from
--    the row itself, so it is reported rather than assumed.
select
  m.id,
  m.lead_id,
  m.recipient_email,
  m.sequence_number,
  m.created_at
from outreach_messages m
where m.sequence_number > 0
  and not exists (
    select 1
    from outreach_messages initial
    where initial.lead_id = m.lead_id
      and initial.recipient_email = m.recipient_email
      and initial.sequence_number = 0
  )
order by m.created_at;

-- 3. MANUAL REVIEW: a follow-up has a due schedule although its initial
--    outreach was never marked sent. Scheduling happens only inside
--    `markFollowUpSent` (called by `recordOutreachSent`), so this combination
--    should be impossible; if rows appear, they need a human decision.
select
  f.id,
  f.lead_id,
  f.recipient_email,
  f.sequence_number,
  l.next_followup_at,
  l.last_contacted_at
from outreach_messages f
join leads l on l.id = f.lead_id
where f.sequence_number > 0
  and l.next_followup_at is not null
  and not exists (
    select 1
    from outreach_messages initial
    where initial.lead_id = f.lead_id
      and initial.recipient_email = f.recipient_email
      and initial.sequence_number = 0
      and (initial.sent_at is not null or initial.status = 'sent')
  )
order by l.next_followup_at;

-- 4. MANUAL REVIEW: status/`sent_at` contradictions on any row.
select id, lead_id, sequence_number, status, sent_at
from outreach_messages
where (status = 'sent' and sent_at is null)
   or (status <> 'sent' and sent_at is not null)
order by created_at;

-- 5. Unrecorded history: the lead counter claims follow-ups that were never
--    stored as rows. The application already reports this per lead in the
--    follow-up detail ("Historical follow-up not recorded"); listed here so
--    the whole table can be reviewed at once.
select
  l.id,
  l.email,
  l.followup_count,
  coalesce(max(m.sequence_number), -1) as highest_stored_sequence,
  l.next_followup_at,
  l.last_contacted_at
from leads l
left join outreach_messages m
  on m.lead_id = l.id
group by l.id, l.email, l.followup_count, l.next_followup_at, l.last_contacted_at
having l.followup_count > coalesce(max(m.sequence_number), -1)
order by l.followup_count - coalesce(max(m.sequence_number), -1) desc;

-- 5b. PEPA 워크플로우 검증: 초기 이메일이 발송되지 않은 리드 중
--     follow-up 일정이 설정된 경우 (비정상 상태).
--     follow-up 일정은 오직 초기 이메일 발송 후에만 설정되어야 함.
select
  l.id,
  l.email,
  l.followup_count,
  l.next_followup_at,
  l.last_contacted_at,
  m.sent_at as initial_sent_at
from leads l
left join outreach_messages m
  on m.lead_id = l.id
  and m.sequence_number = 0
  and (m.sent_at is not null or m.status = 'sent')
where l.next_followup_at is not null
  and m.id is null
order by l.next_followup_at;

-- 6. Expected-shape checks: these MUST return zero rows.
--    6a. duplicate sequence slots (the unique index also guarantees this);
select lead_id, recipient_email, sequence_number, count(*)
from outreach_messages
group by 1, 2, 3
having count(*) > 1;

--    6b. orphaned parent references (Phase 4A ON DELETE SET NULL allows NULL,
--        but a non-null parent must still exist);
select f.id, f.parent_message_id
from outreach_messages f
where f.parent_message_id is not null
  and not exists (
    select 1 from outreach_messages p where p.id = f.parent_message_id
  );

--    6c. notification ledger rows pointing at a message that no longer exists
--        (harmless — the ledger only deduplicates — but visible).
select n.id, n.lead_id, n.followup_number, n.outreach_id
from followup_notifications n
where n.outreach_id is not null
  and not exists (
    select 1 from outreach_messages m where m.id = n.outreach_id
  );
