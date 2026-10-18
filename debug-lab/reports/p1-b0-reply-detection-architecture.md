# PEPA — P1-B.0 Reply Detection Architecture & Provider Audit

**Date:** 2026-10-18  
**Branch:** `master` (HEAD `a1485eb` + P1-A + P1-A.1 fixes)  
**Test Suite:** 1,452 passing, 52 skipped  

---

## 1. Verified Current-State Findings

### 1.1 Email Provider Architecture (V2 Seams Ready)

| Component | Status | Evidence |
|-----------|--------|----------|
| `EmailProvider` interface | **Defined, unimplemented** | `src/lib/providers/types.ts:29-35` |
| Provider registry | **Empty** | `src/lib/providers/registry.ts:26` — `emailProviders` Map is empty |
| `provider_message_id` column | **Exists in DB** | Migration 0000: `provider_message_id text` + unique index `outreach_messages_provider_id_idx` (line 118-120) |
| `provider` column | **Exists in DB** | Migration 0000: `provider text` (line 104) |
| Lead status `replied` | **Defined in enum** | Migration 0000: `outreach_status` enum includes `'replied'` (line 45) |
| Gmail API credentials | **Placeholders only** | `.env.example:79-80` — `GOOGLE_CLIENT_ID/SECRET` commented |

**Key insight:** The entire outbound sending + reply detection architecture is designed but **not implemented**. The schema supports it (provider columns, unique index for reply matching), the interfaces exist, but zero code executes any of it.

### 1.2 Current Outbound Workflow (Manual Only)

```
Operator → clicks "Gmail" → PEPA builds compose URL → Browser opens Gmail
    → Operator manually sends → Operator clicks "Mark as sent" → PEPA records send
```

- **No API call ever made** — `buildGmailComposeUrl` is pure string building (no OAuth, no network)
- **No `provider_message_id` ever set** — `recordOutreachSent` explicitly leaves `provider=null, provider_message_id=null` (line 424 in outreach-service.ts)
- **No reply detection possible** — Without `provider_message_id`, no way to match inbound replies

### 1.3 Inbound Channel: Telegram Only

| Channel | Inbound Support | Notes |
|---------|-----------------|-------|
| Telegram webhook | **Callbacks only** | `route.ts:53-61` — only handles `callback_query`; all messages ignored |
| Email webhook | **None** | No `/api/email/inbound` route exists |
| Gmail API push | **None** | No Pub/Sub topic, no OAuth, no webhook |
| IMAP/SMTP | **None** | No polling infrastructure |

**Telegram webhook explicitly ignores messages:**
```typescript
// route.ts:63-65
// Commands and unrelated update types are acknowledged and ignored.
// The bot is a notification surface; it does not accept instructions.
return ok();
```

### 1.4 Follow-up Cancellation (Ready for Reply Integration)

```typescript
// follow-up-service.ts:718-737
async cancelPending(leadId: string) {
  await clearFollowUpSchedule(leadId);  // next_followup_at = null
  await supabase.from("followup_notifications").delete().eq("lead_id", leadId).eq("status", "claimed");
  await supabase.from("outreach_messages").delete().eq("lead_id", leadId).gt("sequence_number", 0).in("status", ["draft", "ready"]);
}
```

- **Deletes pending drafts** (seq > 0, status draft/ready)
- **Preserves** initial outreach (seq 0) and sent follow-ups
- **Clears** `next_followup_at` and claimed notifications
- **Idempotent** — safe to call multiple times
- **No reply detection calls it** — missing the trigger

### 1.5 Database Support for Reply Matching

```sql
-- Migration 0000 (init.sql lines 118-120)
create unique index outreach_messages_provider_id_idx
  on public.outreach_messages (provider, provider_message_id)
  where provider_message_id is not null;
```

- **Unique partial index** on `(provider, provider_message_id)`
- Enables **O(1) lookup** of PEPA message by provider message ID
- **Already deployed** in production (verified via P0)

---

## 2. Relevant Source Files & Execution Paths

| File | Role |
|------|------|
| `src/lib/providers/types.ts` | Defines `EmailProvider` interface (send returns `providerMessageId`) |
| `src/lib/providers/registry.ts` | Registry for providers (empty) |
| `src/lib/outreach/gmail-compose.ts` | Builds `mailto:` + web + iOS URLs (no API) |
| `src/lib/services/outreach-service.ts:440-559` | `recordOutreachSent` — leaves provider columns null |
| `src/lib/services/follow-up-service.ts:718-737` | `cancelPending` — stops future follow-ups |
| `src/app/api/telegram/webhook/route.ts` | Inbound Telegram (callbacks only) |
| `supabase/migrations/20260101000000_init.sql` | Schema with provider columns + unique index |
| `supabase/migrations/20260101000500_outreach_sequence.sql` | Sequence model with parent_message_id |

---

## 3. Comparison: Gmail API vs. Email Forwarding

### Option A: Gmail API (Full Integration)

| Aspect | Details |
|--------|---------|
| **Mechanism** | OAuth 2.0 → Gmail API `users.messages.send` + Pub/Sub push for inbound |
| **Outbound** | `EmailProvider.send()` calls Gmail API, returns `providerMessageId` (Message-ID header) |
| **Inbound** | Gmail push to Pub/Sub → Cloud Function/webhook → PEPA `/api/email/inbound` |
| **Reply matching** | `In-Reply-To` / `References` headers → match `provider_message_id` via unique index |
| **Google Cloud setup** | Project, OAuth consent screen, Gmail API enabled, Pub/Sub topic, Cloud Function or Cloud Run |
| **OAuth scopes** | `https://www.googleapis.com/auth/gmail.send` + `https://www.googleapis.com/auth/gmail.readonly` + `https://www.googleapis.com/auth/pubsub` |
| **Token storage** | Encrypted in DB (new table) or Vercel environment (refresh token) |
| **Domain verification** | Required for sensitive scopes (gmail.readonly) — takes days/weeks |
| **Operator setup** | 1. Create Google Cloud project 2. Configure OAuth consent 3. Add redirect URI 4. Authorize PEPA 5. Store refresh token |
| **Reliability** | High — official API, push notifications near-real-time |
| **Failure modes** | Token expiry (auto-refresh), Pub/Sub delivery failures, quota limits, domain verification rejection |
| **Maintenance** | Monitor token health, Pub/Sub dead letters, quota usage |

### Option B: Email Forwarding (Lightweight)

| Aspect | Details |
|--------|---------|
| **Mechanism** | Operator sets up Gmail filter: "Forward replies to PEPA" → PEPA receives raw email at webhook |
| **Outbound** | Unchanged (manual compose URLs) — OR optional: use EmailProvider for actual sending |
| **Inbound** | `POST /api/email/inbound` with shared secret → parse `In-Reply-To` / `References` |
| **Reply matching** | Extract `Message-ID` from headers → match `provider_message_id` via unique index |
| **Google Cloud setup** | **None** — uses existing Gmail |
| **OAuth scopes** | **None** |
| **Domain verification** | **None** |
| **Operator setup** | 1. Create Gmail filter: "From: @mydomain.com Has: In-Reply-To" → Forward to `https://pepa.example.com/api/email/inbound?secret=xxx` 2. Configure `EMAIL_INBOUND_SECRET` in Vercel |
| **Reliability** | Medium — depends on Gmail forwarding reliability, header parsing |
| **Failure modes** | Forwarding delays, malformed headers, missing `In-Reply-To`, spam filtering, operator misconfigures filter |
| **Maintenance** | Monitor webhook errors, verify forwarding rule active |

### Comparison Table

| Criterion | Gmail API | Email Forwarding |
|-----------|-----------|------------------|
| **Implementation effort** | High (weeks) | Low-Medium (days) |
| **Operator setup complexity** | High (Google Cloud, OAuth, domain verify) | Low (Gmail filter + secret) |
| **Outbound sending** | ✅ Automatic via API | ❌ Still manual (or add provider later) |
| **Inbound reply detection** | ✅ Push, real-time | ✅ Forwarding, near-real-time |
| **Reply matching accuracy** | High (official Message-ID) | Medium (depends on headers) |
| **Spoofing risk** | Low (OAuth + Pub/Sub auth) | Medium (shared secret, header spoofing possible) |
| **Gmail API quota** | Yes (250/day send, 1B/day read) | No |
| **Domain verification** | Required (sensitive scope) | Not required |
| **Ongoing maintenance** | Token refresh, Pub/Sub monitoring | Webhook monitoring |
| **Time to production** | 2-4 weeks | 3-5 days |

---

## 4. Recommended Architecture: **Email Forwarding First, Gmail API Later**

### Rationale

1. **P1 scope is reply detection, not automatic sending** — Forwarding solves inbound only
2. **Operator can deploy in days, not weeks** — No Google Cloud project, OAuth, domain verification
3. **Existing schema fully supports it** — `provider_message_id` index ready
4. **Manual send workflow preserved** — No change to operator UX
5. **Gmail API can be added later** — Same `provider_message_id` matching logic works for both
6. **Lower security surface** — No OAuth tokens to store/rotate

### Hybrid Path (Recommended)

```
Phase 1 (P1-B): Email Forwarding for reply detection only
  - Operator creates Gmail filter → forwards to PEPA webhook
  - PEPA parses In-Reply-To → matches provider_message_id → cancels follow-ups
  - Manual send workflow unchanged

Phase 2 (Future): Gmail API provider for automatic sending
  - Implement EmailProvider (gmail.ts)
  - Send via API → get real provider_message_id
  - Same reply matching logic works (just different provider source)
```

---

## 5. Proposed Inbound Message Matching Strategy

### 5.1 Matching Algorithm

```typescript
// POST /api/email/inbound
// 1. Verify shared secret (constant-time compare)
// 2. Parse raw email (RFC 5322)
// 3. Extract identifiers:
//    - inReplyTo = headers["In-Reply-To"]?.trim()  // Single Message-ID
//    - references = headers["References"]?.split(/\s+/)  // Chain of Message-IDs
// 4. Candidate IDs = [inReplyTo, ...references].filter(Boolean).map(normalizeMessageId)
// 5. For each candidateId:
//      SELECT * FROM outreach_messages 
//      WHERE provider_message_id = candidateId 
//      AND provider IN ('gmail', 'apple_mail')  // only known providers
//      LIMIT 1
// 6. If exactly ONE match → proceed
// 7. If ZERO matches → log, return 200 (silent ignore)
// 8. If MULTIPLE matches (ambiguous) → flag for manual review, DON'T auto-cancel
```

### 5.2 Message-ID Normalization

```typescript
function normalizeMessageId(raw: string): string {
  // Strip angle brackets, whitespace
  return raw.replace(/^<|>$/g, "").trim().toLowerCase();
}
```

### 5.3 Why This Works

- **Gmail includes `In-Reply-To`** with the original Message-ID on replies
- **PEPA stores `provider_message_id`** from outbound send (Phase 2) or can be set manually
- **Unique index** guarantees at most one match per provider+messageId
- **References chain** handles forwarded threads where `In-Reply-To` points to intermediate message

---

## 6. Proposed Duplicate Handling & Follow-up Cancellation Strategy

### 6.1 Idempotent Reply Recording

```typescript
async function recordReply(input: { messageId: string; provider: EmailProviderId; inboundEmail: RawEmail }): Promise<ReplyResult> {
  // 1. Upsert inbound email (dedupe by Message-ID)
  const { data: existing } = await supabase
    .from("inbound_emails")
    .insert({ message_id: input.messageId, provider: input.provider, raw: input.inboundEmail })
    .onConflict("message_id")
    .ignore()
    .select()
    .maybeSingle();
  
  if (existing) return { outcome: "duplicate" }; // Already processed
  
  // 2. Match to PEPA outreach
  const match = await findOutreachByProviderMessageId(input.provider, input.messageId);
  if (!match) return { outcome: "no_match" };
  
  // 3. Update lead status + cancel follow-ups (transactional)
  const { error } = await supabase.rpc("record_reply_and_cancel", {
    p_lead_id: match.lead_id,
    p_outreach_id: match.id,
    p_inbound_id: existing.id
  });
  
  return { outcome: "recorded", leadId: match.lead_id };
}
```

### 6.2 Cancellation Requirements

| Requirement | Implementation |
|-------------|----------------|
| Match correct lead/conversation | `provider_message_id` unique index → exact match |
| Record idempotently | `inbound_emails` table with PK on `message_id` + `ON CONFLICT DO NOTHING` |
| Stop future follow-ups | Call existing `followUpService.cancelPending(leadId)` |
| Preserve history | Cancel only deletes draft/ready follow-ups (seq > 0); sent messages preserved |
| Handle ambiguous matches | Multiple candidates → flag for manual review, **no auto-cancel** |

### 6.3 Database Migration Needed (Minimal)

```sql
-- New table for inbound email deduplication
create table public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text not null,  -- normalized Message-ID
  provider text not null,    -- 'gmail', 'apple_mail', etc.
  raw_email jsonb not null,  -- full parsed email for audit
  matched_outreach_id uuid references public.outreach_messages (id) on delete set null,
  matched_lead_id uuid references public.leads (id) on delete set null,
  processed_at timestamptz not null default now(),
  status text not null default 'pending', -- 'pending', 'matched', 'no_match', 'ambiguous'
  constraint inbound_emails_message_id_key unique (message_id)
);

-- RPC for atomic reply recording + cancellation
create or replace function public.record_reply_and_cancel(
  p_lead_id uuid,
  p_outreach_id uuid,
  p_inbound_id uuid
) returns void
language plpgsql
as $$
begin
  update public.leads set status = 'replied', next_followup_at = null, updated_at = now() where id = p_lead_id;
  update public.outreach_messages set status = 'replied' where id = p_outreach_id;
  update public.inbound_emails set status = 'matched', matched_lead_id = p_lead_id, matched_outreach_id = p_outreach_id where id = p_inbound_id;
  delete from public.followup_notifications where lead_id = p_lead_id and status = 'claimed';
  delete from public.outreach_messages where lead_id = p_lead_id and sequence_number > 0 and status in ('draft', 'ready');
end;
$$;
```

---

## 7. Security & Privacy Considerations

| Concern | Mitigation |
|---------|------------|
| **Spoofed replies** | Require `In-Reply-To` matching existing `provider_message_id`; unknown IDs ignored |
| **Header injection** | Use robust email parser (e.g., `mailparser`); never trust headers blindly |
| **Webhook secret** | Constant-time compare; rotate `EMAIL_INBOUND_SECRET` periodically |
| **Data exposure** | Inbound emails stored in `inbound_emails.raw_email` (JSONB) — encrypted at rest in Supabase |
| **Operator privacy** | Only operator's own Gmail forwards to PEPA; no third-party data |
| **Rate limiting** | Vercel cron-like protection on `/api/email/inbound` (optional) |

---

## 8. Required Operator Setup

### For Email Forwarding (Recommended)

| Step | Action |
|------|--------|
| 1 | Generate `EMAIL_INBOUND_SECRET` (32+ chars): `openssl rand -base64 32` |
| 2 | Add to Vercel: `EMAIL_INBOUND_SECRET=<value>` |
| 3 | In Gmail: Settings → Filters → Create new filter |
| 4 | Filter criteria: `Has the words: "In-Reply-To:"` (or `from:(@yourdomain.com)` + `has:reply`) |
| 5 | Action: Forward to `https://pepa.example.com/api/email/inbound?secret=<EMAIL_INBOUND_SECRET>` |
| 6 | Test: Send test email to yourself, reply, verify PEPA logs show match |

### For Gmail API (Future)

| Step | Action |
|------|--------|
| 1 | Create Google Cloud project |
| 2 | Enable Gmail API + Pub/Sub API |
| 3 | Configure OAuth consent screen (external, sensitive scope) |
| 4 | Create OAuth 2.0 Client ID (Web application) |
| 5 | Add authorized redirect: `https://pepa.example.com/api/auth/google/callback` |
| 6 | Submit for domain verification (required for `gmail.readonly`) |
| 7 | Store `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` in Vercel |
| 8 | Run OAuth flow once to get refresh token, store securely |

---

## 9. Minimal Implementation Plan

### Phase 1: Email Forwarding Webhook (P1-B)

| Task | Scope | Acceptance Criteria |
|------|-------|---------------------|
| 1. Create `/api/email/inbound` route | Small | Accepts POST, verifies `secret` param, parses raw email |
| 2. Add `inbound_emails` table + migration | Small | Unique index on `message_id`, FK to outreach/leads |
| 3. Implement `recordReply` service | Small | Matches `In-Reply-To` → `provider_message_id`, calls `cancelPending` |
| 4. Add RPC `record_reply_and_cancel` | Small | Atomic: lead=replied, cancel follow-ups, delete drafts |
| 5. Unit tests for parser + matching | Medium | RFC 5322 edge cases, ambiguous match handling |
| 6. Integration test with mock forward | Medium | End-to-end: forward → webhook → match → cancel |

### Phase 2: Gmail API Provider (Future P1-B or P2)

| Task | Scope |
|------|-------|
| Implement `GmailProvider` class | Medium |
| OAuth token storage + refresh | Medium |
| `send()` returns real `providerMessageId` | Small |
| Pub/Sub push webhook for inbound | Medium |

---

## 10. Unresolved Questions

| Question | Impact | Resolution Needed |
|----------|--------|-------------------|
| **Operator preference** | Determines Phase 1 vs Phase 2 priority | Operator decision needed |
| **Gmail filter reliability** | Forwarding may miss some replies (filters, spam) | Test with operator's actual Gmail |
| **Shared mailbox replies** | If multiple people reply from same address | Match by `In-Reply-To` still works (Message-ID unique per thread) |
| **Reply from different address** | Lead replies from `personal@gmail.com` instead of `work@company.com` | `In-Reply-To` still references original Message-ID — works |
| **Threading edge cases** | Multiple PEPA messages in same thread (initial + FU1 + FU2) | `References` chain handles; ambiguous → manual review |
| **Attachment handling** | Inbound emails with attachments | Store in `raw_email` JSONB; ignore for matching |

---

## 11. Recommendation Summary

| Decision | Recommendation |
|----------|----------------|
| **Approach** | **Email Forwarding first** (Phase 1), Gmail API later (Phase 2) |
| **Matching key** | `In-Reply-To` + `References` headers → `provider_message_id` unique index |
| **Duplicate handling** | `inbound_emails` table with PK on `message_id` + `ON CONFLICT DO NOTHING` |
| **Cancellation** | Reuse existing `followUpService.cancelPending(leadId)` (verified safe) |
| **Ambiguous matches** | Flag for manual review, never auto-cancel |
| **Schema change** | 1 new table (`inbound_emails`) + 1 RPC (`record_reply_and_cancel`) |
| **Operator action** | Create Gmail filter + set `EMAIL_INBOUND_SECRET` in Vercel |

---

## 12. Confirmation

**No code modified during this audit.**  
**No production changes made.**  
**All findings based on direct inspection of:**
- `src/lib/providers/types.ts`, `registry.ts`, `notifications.ts`, `telegram.ts`
- `src/lib/outreach/gmail-compose.ts`
- `src/lib/services/outreach-service.ts`, `follow-up-service.ts`
- `src/app/api/telegram/webhook/route.ts`
- `supabase/migrations/20260101000000_init.sql`, `20260101000500_outreach_sequence.sql`
- `.env.example`

---

*Report generated from repository inspection at `C:\Users\PC\Desktop\Pepa` on 2026-10-18.*