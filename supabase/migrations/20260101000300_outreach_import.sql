-- PEPA P3 — ChatGPT outreach import.
--
-- There is deliberately NO new table. An imported message is an ordinary
-- `outreach_messages` row in status 'draft', so:
--
--   * IMPORT != SENT — status stays 'draft' and `sent_at` stays NULL until a
--     provider actually sends it. Nothing about an import marks it as sent.
--   * dedupe is unchanged — the unique indexes on `leads.email_normalized` and
--     (lead_id, recipient_normalized) keep doing their existing job.
--
-- The only schema change required is a new token purpose. `outreach_import` is
-- stored in the SAME `action_tokens` table, so a single digest lookup, a single
-- expiry rule and a single purpose check govern both deep-link kinds, and a
-- token minted for an import can never open a follow-up link (or vice versa).

alter table public.action_tokens
  drop constraint if exists action_tokens_purpose_check;

alter table public.action_tokens
  add constraint action_tokens_purpose_check
    check (purpose in ('followup_composer', 'outreach_import'));

comment on constraint action_tokens_purpose_check on public.action_tokens is
  'Purpose scoping. An outreach_import token opens only an imported draft; a followup_composer token opens only a follow-up. The raw token is never stored.';

-- Import links are short-lived by nature: the payload is pasted once, reviewed
-- and edited immediately. This index supports the expiry sweep that already
-- exists for follow-up tokens.
create index if not exists action_tokens_import_idx
  on public.action_tokens (expires_at)
  where purpose = 'outreach_import';