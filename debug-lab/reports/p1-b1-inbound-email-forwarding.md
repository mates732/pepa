# PEPA — P1-B.1 Inbound Email Forwarding: Blocker Report

**Date:** 2026-10-18  
**Branch:** `master` (HEAD `a1485eb` + P1-A + P1-A.1 fixes)  
**Test Suite:** 1,452 passing, 52 skipped  

---

## Executive Summary

**BLOCKER CONFIRMED:** The current manual-send workflow **cannot reliably supply the outbound message's RFC `Message-ID`**, which is required for matching inbound replies via `In-Reply-To` headers.

PEPA uses Gmail compose URLs (`mailto:` + web) that open a draft in the operator's Gmail. When the operator clicks "Send" in Gmail, Gmail generates a new `Message-ID` header. **PEPA never learns this `Message-ID`** — `recordOutreachSent()` only sets `status='sent'` and `sent_at`, leaving `provider=null` and `provider_message_id=null`.

Without the outbound `Message-ID`, PEPA cannot match incoming replies that reference it via `In-Reply-To` / `References` headers.

---

## Phase 0: Prerequisite Verification

### 1. Production Hostname & Deployment
| Item | Value |
|------|-------|
| Vercel Production URL | `https://pepa-rho.vercel.app` |
| `PEPA_BASE_URL` | Set in production (masked in env pull) |
| Supabase Project | `tvfftmnkjxbcpzyotfsz` (West EU) |
| Cron Endpoints | `/api/cron/followups`, `/api/cron/streak-reminders` |

### 2. Outbound Message Identification (Current State)

| Column | Current Behavior | Can Match Replies? |
|--------|------------------|-------------------|
| `provider` | Always `null` | ❌ No |
| `provider_message_id` | Always `null` | ❌ No |
| `sent_at` | Set on "Mark as sent" | ❌ Timestamp only |
| `sequence_number` | Set correctly | ⚠️ Order only |

**Evidence:** `recordOutreachSent()` in `outreach-service.ts:508-518`:
```typescript
.update({ status: "sent", sent_at: toUtcIso(sentAt) })  // provider & provider_message_id NOT set
```

### 3. Gmail Compose URL Limitation
- `buildGmailComposeUrl()` generates `mailto:` / web URLs with `to`, `subject`, `body`
- **No `In-Reply-To` or `References` headers** can be set via mailto: or web compose
- **No `Message-ID`** can be pre-set — Gmail generates it on send
- **No callback/webhook** from Gmail when operator clicks "Send"

### 4. Existing Reply Matching Infrastructure (Ready but Unused)
- ✅ `provider_message_id` column exists (migration 0000)
- ✅ Unique partial index: `outreach_messages_provider_id_idx` on `(provider, provider_message_id)`
- ✅ Lead status `'replied'` defined in enum
- ✅ `followUpService.cancelPending(leadId)` implemented and tested
- ✅ `cancelPending` deletes pending drafts, preserves sent messages, clears schedule

---

## The Blocker

### Required for Reliable Reply Matching
```
Inbound Reply → In-Reply-To: <outbound-message-id@domain>
                → PEPA looks up: WHERE provider_message_id = outbound-message-id
                → Found → cancelPending(leadId)
```

### Current Reality
```
Outbound: Operator sends via Gmail compose URL
          → Gmail generates Message-ID: <abc123@gmail.com>
          → PEPA records: provider=null, provider_message_id=null

Inbound:  Reply arrives with In-Reply-To: <abc123@gmail.com>
          → PEPA looks up: WHERE provider_message_id = 'abc123@gmail.com'
          → NO MATCH (column is null)
          → Reply unmatched → follow-ups continue
```

**Result:** Zero reply detection capability with current manual-send workflow.

---

## Smallest Required Change

To enable reply detection with email forwarding, PEPA must capture the outbound `Message-ID` when an email is sent.

### Option A: Operator Manual Entry (Simplest, Low Fidelity)
Add a "Gmail Message-ID" field to the "Mark as sent" dialog where the operator pastes the Message-ID from Gmail's "Show original" (Ctrl+U).

**Pros:** No new infrastructure, works immediately  
**Cons:** Manual, error-prone, operator friction

### Option B: Custom Reply-To Address (Medium Complexity)
Generate a unique reply-to address per outreach: `reply+<messageId>@pepa.example.com`
- Requires email routing on `pepa.example.com` (or subdomain)
- When reply arrives at that address → PEPA knows exactly which message
- Can forward to PEPA inbound endpoint

**Pros:** Automatic, no operator action  
**Cons:** Requires custom domain email routing (MX records, email service)

### Option C: EmailProvider Implementation (Recommended for Reliability)
Implement `GmailProvider` class that sends via Gmail API:
- `send()` returns real `providerMessageId` from Gmail API response
- `provider='gmail'`, `provider_message_id=<actual-message-id>` stored automatically
- Same inbound matching logic works

**Pros:** Reliable, automatic, enables automatic sending later  
**Cons:** Requires Google Cloud project, OAuth, domain verification (2-4 weeks)

### Option D: Hybrid — Manual Entry + Forwarding (Minimal Viable for P1-B)
1. Add optional `provider_message_id` field to "Mark as sent" action
2. Operator can optionally paste Gmail Message-ID
3. If provided → reply detection works for that message
4. If not provided → reply detection unavailable (graceful degradation)

---

## Recommendation

**Do not implement P1-B.1 email forwarding yet.** The current manual-send workflow **fundamentally cannot** provide the required `provider_message_id`.

### Recommended Path Forward

1. **P1-B.1a (Immediate):** Add optional `provider_message_id` field to `recordOutreachSent` / "Mark as sent" UI
   - Operator can paste Message-ID from Gmail "Show original"
   - If provided, inbound forwarding works
   - If not, graceful degradation

2. **P1-B.1b (Parallel):** Implement `GmailProvider` for automatic sending
   - Captures `Message-ID` automatically
   - Eliminates manual step
   - Enables full P1-B (reply detection + auto-send)

3. **P1-B.1c (Then):** Implement inbound email forwarding webhook
   - Works with either Option A or B above

---

## Phase 1-4: Not Implemented (Blocked)

### Phase 1: Inbound Endpoint
**Not implemented** — no reliable matching possible without outbound Message-ID

### Phase 2: Reply Matching
**Not implemented** — depends on `provider_message_id` being populated

### Phase 3: Idempotent Persistence
**Schema designed** (see P1-B.0 report) but not created:
```sql
create table public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text not null,
  provider text not null,
  raw_email jsonb not null,
  matched_outreach_id uuid references public.outreach_messages (id) on delete set null,
  matched_lead_id uuid references public.leads (id) on delete set null,
  processed_at timestamptz not null default now(),
  status text not null default 'pending',
  constraint inbound_emails_message_id_key unique (message_id)
);
```

### Phase 4: Follow-up Cancellation
**Ready** — `followUpService.cancelPending(leadId)` works correctly once match is confirmed

---

## Phase 5: Gmail Forwarding Setup (Documented for Future)

When `provider_message_id` is available, operator setup:

```bash
# 1. Generate secret
openssl rand -base64 32
# → Add to Vercel: EMAIL_INBOUND_SECRET=<value>

# 2. Inbound endpoint (when implemented)
# POST https://pepa-rho.vercel.app/api/email/inbound?secret=<EMAIL_INBOUND_SECRET>
# Headers: Content-Type: message/rfc822 (raw email)

# 3. Gmail Filter:
# Has the words: "In-Reply-To:"
# Action: Forward to https://pepa-rho.vercel.app/api/email/inbound?secret=<SECRET>
```

---

## Tests: Not Added (Blocked)

| Test | Status |
|------|--------|
| Valid authenticated inbound request | ⏸️ Blocked |
| Missing/invalid secret | ⏸️ Blocked |
| Exact `In-Reply-To` match | ⏸️ Blocked |
| Unambiguous `References` match | ⏸️ Blocked |
| Unknown message ID | ⏸️ Blocked |
| Ambiguous match | ⏸️ Blocked |
| Duplicate delivery | ⏸️ Blocked |
| Cancellation after confirmed match | ⏸️ Blocked |
| No cancellation for unmatched | ⏸️ Blocked |

---

## Files That Would Need Changes (If Proceeding)

| File | Change Required |
|------|-----------------|
| `src/lib/services/outreach-service.ts` | Add optional `providerMessageId` to `recordOutreachSent` |
| `src/app/actions.ts` | Pass `providerMessageId` from UI |
| `src/components/*` | Add "Gmail Message-ID" input to "Mark as sent" dialog |
| `supabase/migrations/..._inbound_emails.sql` | New table (see Phase 3) |
| `src/app/api/email/inbound/route.ts` | New endpoint |
| `src/lib/services/inbound-email-service.ts` | New service |
| `src/lib/services/inbound-email-service.test.ts` | Tests |

---

## Verification Results

| Check | Status |
|-------|--------|
| Current tests pass | ✅ 1,452 passing |
| TypeScript clean | ✅ |
| Production build | ✅ |
| `provider_message_id` populated in production | ❌ **Confirmed NULL** |
| Reply detection feasible with current data | ❌ **BLOCKED** |

---

## Conclusion

**P1-B.1 cannot be implemented reliably with the current manual-send workflow.** The critical `provider_message_id` is never captured.

**Next Step:** Implement Option D (manual Message-ID entry) or Option C (EmailProvider) before proceeding with inbound email forwarding.

**Decision Required from Operator:**
1. Accept manual Message-ID entry as interim solution?
2. Prioritize EmailProvider (Gmail API) implementation?
3. Use custom reply-to address with email routing?

Until this is resolved, **no inbound email implementation should proceed** — it would create a false sense of reply detection capability.