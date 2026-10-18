# PEPA — P1-B.3 Inbound Reply Detection: Blocker Report

**Date:** 2026-10-18  
**Branch:** `master` (HEAD `a1485eb` + P1-A + P1-A.1 + P1-B.2)  
**Test Suite:** 1,452 passing, 52 skipped  

---

## Executive Summary

**BLOCKER CONFIRMED:** No inbound email receiving infrastructure exists in the PEPA repository. The project has no email provider configured (Resend, SendGrid, Mailgun, Postmark, etc.), no webhook endpoint for inbound email, no domain/MX configuration documented, and no email parsing libraries installed.

The only inbound integration is **Telegram** (for follow-up notifications). Gmail's standard forwarding feature forwards to an **email address**, not an HTTP endpoint. The task explicitly prohibits documenting or implementing a Gmail filter that forwards directly to a URL.

**End-to-end reply detection cannot be implemented without first establishing an inbound email receiving mechanism.**

---

## Phase 0: Inbound Delivery Feasibility Verification

### Current State

| Component | Status | Evidence |
|-----------|--------|----------|
| **Email provider (Resend/SendGrid/Mailgun/Postmark)** | ❌ Not configured | `package.json` has no email provider dependencies |
| **Inbound email webhook endpoint** | ❌ Not implemented | Only `/api/telegram/webhook`, `/api/cron/*`, `/api/import` exist |
| **Domain/MX configuration** | ❌ Not documented | `docs/production-deployment.md` only mentions Telegram webhook |
| **Email parsing library (mailparser, etc.)** | ❌ Not installed | No email-related packages in `package.json` or `package-lock.json` |
| **Receiving email address/domain** | ❌ Not configured | No mention in `.env.example`, `.env.production.local`, or docs |
| **Gmail filter → HTTP endpoint** | ❌ Prohibited by task | "Do not document or implement a Gmail filter that forwards directly to a URL" |

### Verified Inbound Architecture

The **only** inbound integration is Telegram:

```
Telegram Bot API → /api/telegram/webhook (secret_token + chat_id auth)
                  → Callback query handling only
                  → Ignores all messages (only processes callback_query)
```

**Production deployment docs confirm** (`docs/production-deployment.md:7-8`):
> "PEPA is a single-operator, password-gated app. It has exactly one client (a browser), one scheduled job (Vercel Cron) and **one inbound integration (Telegram)**."

### Gmail Forwarding Limitation

Gmail's standard forwarding feature:
- Forwards to an **email address** (e.g., `replies@pepa.example.com`)
- **Cannot** forward directly to an HTTP endpoint (webhook URL)
- Requires a **receiving email domain** with MX records pointing to an email provider

The task explicitly prohibits: "Do not document or implement a Gmail filter that forwards directly to a URL."

---

## Blocking Requirements

To implement inbound reply detection, **one of the following must be established first**:

### Option A: Configure an Email Receiving Provider

| Provider | Inbound Support | Webhook Format | MX Required |
|----------|-----------------|----------------|-------------|
| **Resend** | ✅ Inbound parsing → webhook | JSON with parsed headers/body | ✅ Domain + MX |
| **SendGrid** | ✅ Inbound parse → webhook | JSON with parsed headers/body | ✅ Domain + MX |
| **Mailgun** | ✅ Routes → webhook | JSON with parsed headers/body | ✅ Domain + MX |
| **Postmark** | ✅ Inbound → webhook | JSON with parsed headers/body | ✅ Domain + MX |
| **Cloudflare Email Routing** | ✅ Workers → webhook | Custom | ✅ Domain + MX |
| **Custom SMTP + Worker** | ✅ Self-hosted | Custom | ✅ Domain + MX |

**All require:**
1. A verified domain (e.g., `pepa.example.com`)
2. MX records pointing to the provider
3. Provider account + API keys
4. Webhook endpoint in PEPA (`/api/email/inbound`)

### Option B: Custom Reply-To Address (No New Provider)

Use a unique `reply-to` address per outreach:
- Format: `reply+<messageId>@pepa.example.com`
- Gmail replies to this address
- Requires: Domain + MX + email receiving infrastructure (same as Option A)

---

## What Can Be Completed Without Provider

The following components are **implementation-ready** but **cannot be end-to-end tested** without an inbound provider:

### 1. Inbound Endpoint Structure (`/api/email/inbound`)

```typescript
// Would verify provider signature (Resend/SendGrid/Mailgun)
// Parse payload → extract In-Reply-To, References, sender, recipient
// Normalize Message-IDs via normalizeMessageId()
// Match via provider_message_id unique index
// Call followUpService.cancelPending(leadId) on confident match
```

### 2. Inbound Persistence Schema

```sql
-- Migration ready (not applied)
create table public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text not null,           -- inbound RFC Message-ID
  provider text not null,             -- 'resend', 'sendgrid', etc.
  in_reply_to text,                   -- original outbound Message-ID
  references text,                    -- References chain
  sender_email text not null,
  recipient_email text not null,
  subject text,
  matched_outreach_id uuid references public.outreach_messages (id) on delete set null,
  matched_lead_id uuid references public.leads (id) on delete set null,
  processed_at timestamptz not null default now(),
  status text not null default 'pending', -- 'pending', 'matched', 'no_match', 'ambiguous'
  raw_payload jsonb,                  -- minimal: headers only, no body
  constraint inbound_emails_message_id_key unique (message_id)
);
```

### 3. Matching Logic

```typescript
// Exact In-Reply-To match → unique index lookup on (provider, provider_message_id)
// References chain fallback → unambiguous only
// Never match on sender/subject/timestamp alone
// Ambiguous → status='ambiguous', no auto-cancel
```

### 4. Idempotent Persistence + Cancellation

```typescript
// INSERT ... ON CONFLICT (message_id) DO NOTHING
// If matched: lead.status='replied', call cancelPending(leadId)
// cancelPending already tested: deletes pending drafts, clears schedule, preserves history
```

---

## What Cannot Be Done

| Item | Reason |
|------|--------|
| End-to-end test with real Gmail reply | No receiving email address/domain |
| Webhook signature verification | No provider to define signature format |
| Gmail filter setup documentation | No receiving address to forward to |
| Retry behavior testing | No real webhook deliveries |
| Operator setup instructions | No provider to configure |

---

## Required Operator Decisions

Before P1-B.3 can proceed, the operator must choose and configure:

| Decision | Required Action |
|----------|-----------------|
| **Email receiving provider** | Choose Resend/SendGrid/Mailgun/Postmark/Cloudflare |
| **Receiving domain** | Register/verify domain (e.g., `replies.pepa.example.com`) |
| **MX records** | Point to provider's inbound servers |
| **Provider API keys** | Add to Vercel env: `RESEND_WEBHOOK_SECRET`, etc. |
| **PEPA webhook URL** | `https://pepa-rho.vercel.app/api/email/inbound` |

---

## Completed Implementation (Ready When Provider Available)

| Component | Status | Files |
|-----------|--------|-------|
| Outbound Message-ID capture (P1-B.2) | ✅ Complete | `outreach-service.ts`, `actions.ts`, UI components |
| `normalizeMessageId()` utility | ✅ Complete | `outreach-service.ts` |
| `provider_message_id` schema + unique index | ✅ Deployed | Migration 0000, verified in production |
| `cancelPending()` follow-up cancellation | ✅ Complete & tested | `follow-up-service.ts` |
| Inbound matching logic design | ✅ Documented | P1-B.0 report |

---

## Files That Would Need Changes (When Provider Chosen)

| File | Change |
|------|--------|
| `package.json` | Add email provider SDK (e.g., `resend`, `@sendgrid/mail`) |
| `src/app/api/email/inbound/route.ts` | **New** — provider webhook endpoint |
| `supabase/migrations/..._inbound_emails.sql` | **New** — inbound emails table |
| `src/lib/services/inbound-email-service.ts` | **New** — parsing, matching, persistence |
| `src/lib/services/inbound-email-service.test.ts` | **New** — tests with provider mock payloads |
| `.env.example` | Add `EMAIL_INBOUND_SECRET`, provider-specific vars |
| `docs/production-deployment.md` | Document domain/MX/provider setup |
| `src/app/api/email/inbound/route.test.ts` | **New** — tests |

---

## Verification Status

| Check | Result |
|-------|--------|
| Current tests pass | ✅ 1,452 passing |
| TypeScript clean | ✅ |
| Production build | ✅ Successful |
| Inbound provider configured | ❌ **BLOCKED** |
| End-to-end reply detection verified | ❌ **NOT POSSIBLE** |

---

## Recommendation

**Do not implement P1-B.3 inbound webhook yet.** The architecture is designed and ready, but without an inbound email receiving provider and domain/MX setup, the feature cannot be verified end-to-end.

### Recommended Path Forward

1. **Operator decision:** Choose email receiving provider (Resend recommended — simple API, good inbound parsing)
2. **Operator action:** Register domain, configure MX records, add provider API keys to Vercel
3. **Then implement:** `/api/email/inbound` webhook + `inbound_emails` table + matching logic
4. **Then test:** End-to-end with real Gmail replies forwarded to receiving address

---

## Conclusion

**P1-B.3 is blocked on infrastructure, not code.** The manual Message-ID capture (P1-B.2) is complete and working. The database schema supports reply matching. The cancellation logic is tested and safe. But without an email receiving provider and domain, inbound replies have nowhere to land.

**Next step:** Operator must provision an email receiving provider and domain before P1-B.3 implementation can proceed.