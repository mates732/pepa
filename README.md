# Outreach Tool

Internal tool for cold outreach. Paste the structured output from ChatGPT, check
for duplicates, review the email, save it as a draft. Sending and follow-ups are
deliberately **not** implemented yet — the seams for them are in place.

**PEPA THE OUTMAN** — private, single-user, password-gated. Every route except
`/login` requires a signed session cookie.

Workflow: **Paste → Parse → Check duplicate → Review → Save/Send**

## Requirements

- Node.js 20+
- A Supabase project (free tier is fine)

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in the three Supabase values
npm run dev                  # http://localhost:3000
```

Apply the database schema — either link the project with the Supabase CLI and run
`supabase db push`, or paste
`supabase/migrations/20260101000000_init.sql` into the Supabase SQL editor.

The dashboard renders a setup notice (instead of crashing) when Supabase is
unreachable or the environment variables are missing.

| Command          | Purpose                    |
| ---------------- | -------------------------- |
| `npm run dev`    | Dev server                 |
| `npm run build`  | Production build           |
| `npm run lint`   | ESLint                     |
| `npm run typecheck` | `tsc --noEmit`          |
| `npm test`       | Parser + normalization tests |

### Environment variables

| Variable                        | Required | Purpose                                                    |
| ------------------------------- | -------- | ---------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | yes      | Project URL                                                |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes      | Browser-safe anon key (reserved for V2 realtime features)  |
| `SUPABASE_SERVICE_ROLE_KEY`     | yes      | **Server-only.** Bypasses RLS — never expose it to the client |
| `PEPA_PASSWORD`                 | yes      | The single operator's password. Server-only, ≥ 12 chars      |
| `PEPA_SESSION_SECRET`           | yes      | HMAC key for the session cookie. Server-only, ≥ 32 chars     |
| `TELEGRAM_BOT_TOKEN`            | for Telegram | Bot token. Server-only, never `NEXT_PUBLIC_`             |
| `TELEGRAM_CHAT_ID`              | for Telegram | The one chat allowed to interact with PEPA             |
| `TELEGRAM_WEBHOOK_SECRET`       | for Telegram | Echoed back by Telegram as `X-Telegram-Bot-Api-Secret-Token` |

Optional: `PEPA_BASE_URL` (canonical origin for deep links; falls back to the
request host) and `PEPA_ENABLE_DEV_TOOLS` (shows the "Test Telegram" button in a
production build).

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` remain placeholders for V2 only.

Generate the session secret:

```bash
openssl rand -base64 32
```

## Authentication

### Why not Supabase Auth

The deliberate design here is *RLS on, no client policies, service-role access
only* — the anon key is not a data path at all. Supabase Auth's canonical
pattern (`@supabase/ssr` with a user-scoped client) needs RLS policies and
per-user clients, which would mean either duplicating every data path or
reopening RLS. For a single operator with no registration, no password reset and
no third parties, a signed cookie is less code, no extra dependency, and no
auth provider in the request path. `requireAuthenticatedUser()` is the only
seam that would change if this decision is ever revisited.

### Model

- One shared password, stored only as the `PEPA_PASSWORD` environment variable.
  There is no user table, no registration and no recovery flow — rotating the
  variable is the whole "user management" story.
- Login failure always returns the same message (`Invalid credentials.`); it
  never reveals whether a value was close, and the rate limiter is generic too.
- Password comparison is constant-time (SHA-256 digests via `timingSafeEqual`).

### Session

- **Stateless**, HMAC-SHA256 signed with `PEPA_SESSION_SECRET`:
  `v1.<base64url(payload)>.<signature>`.
- Cookie `pepa_session`: `HttpOnly`, `SameSite=Lax`, `Secure` in production,
  `Path=/`, 30-day expiry.
- Verified server-side on every request. `Proxy` performs the optimistic
  redirect; `verifySession()` (pages) and `requireAuthenticatedUser()` (Server
  Actions) are the authoritative checks, per the Next.js DAL pattern.
- **Sliding expiry**: Proxy re-signs the cookie once it is more than half way
  through its life. Stateless tokens cannot be revoked, so this keeps a stolen
  cookie's useful window short while an active operator stays signed in.
- Logout is a `<form action>` Server Action that clears the cookie, so no
  client-side script ever needs access to it.
- Limitation, by design: because the session is stateless, a token copied before
  logout stays valid until it expires or the secret is rotated. Rotating
  `PEPA_SESSION_SECRET` invalidates every existing session immediately.

### Rate limiting

In-process, per client IP: 5 failures triggers an exponential lockout
(1 min → 30 min), cleared on success. It blunts online guessing; it is **not** a
security boundary and resets on a cold start or serverless recycle.

### Layers of defence

| Layer | Mechanism |
| ----- | --------- |
| Edge | `src/proxy.ts` — redirects anonymous requests to `/login` |
| Pages | `verifySession()` in `src/app/page.tsx` and `/followup/[token]` |
| Mutations | `requireAuthenticatedUser()` at the top of every privileged Server Action; it **throws**, so no caller can forget to check |
| Data | RLS enabled with no client policies; service-role client imported only from `server-only` modules |

`/api/*` is deliberately excluded from the Proxy matcher so the Telegram webhook
is reachable by Telegram rather than by a PEPA session; it authenticates with
Telegram's own secret-token header instead. Any future API route must call
`requireAuthenticatedUser()` itself. Server Actions are POSTs to page routes, so
they stay covered by both Proxy and their own check.

## Keyboard shortcuts

| Shortcut | Action                        |
| -------- | ----------------------------- |
| `⌘/Ctrl + Enter` | Parse the pasted block and run the duplicate check |
| `⌘/Ctrl + S`     | Save draft                    |
| `⌘/Ctrl + K`     | Clear the composer            |
| `⌘/Ctrl + /`     | Focus the paste box           |

## Layout

```
src/
  app/
    layout.tsx              root layout
    page.tsx                server component: env check + history load
    actions.ts              server functions (checkRecipient, saveDraft)
  components/
    dashboard.tsx           client orchestrator for the three areas
    paste-import.tsx        1 · paste / parse
    email-composer.tsx      2 · composer
    duplicate-notice.tsx    NEW LEAD / EXISTING LEAD / ALREADY CONTACTED
    outreach-history.tsx    3 · history table
    setup-notice.tsx        configuration / schema errors
    status-badge.tsx        status pill
  lib/
    types.ts                shared domain types
    parser.ts               parseOutreachInput()
    email.ts                normalizeEmail(), isValidEmail()
    format.ts               date + label helpers
    auth/
      token.ts              signed session token (pure crypto, used by Proxy too)
      cookie.ts             HttpOnly cookie set/clear
      dal.ts                verifySession / requireAuthenticatedUser / currentUser
      env.ts                auth env validation + constant-time password check
      rate-limit.ts         login throttle
      redirect.ts           safeRedirectPath() (open-redirect guard)
    providers/
      types.ts              EmailProvider, FollowUpService, NotificationService
      registry.ts           provider registry (empty until V2)
    config/env.ts           aggregated "is this deployment configured?" check
    services/
      lead-service.ts       findLeadByEmail, createLead, getLead, setLeadStatus
      outreach-service.ts   createDraft, getLeadOutreachHistory, listOutreachHistory
    supabase/
      server.ts             service-role client + env status
      client.ts             anon browser client (reserved for V2)
  proxy.ts                  Next.js 16 Proxy: optimistic session redirect
supabase/migrations/
  20260101000000_init.sql   full schema
```

## Telegram + deep links (P1)

Telegram is a **notification and control surface**, not a place where outreach
content lives. It carries a company name, an email address and an opaque link —
never a subject or a body.

### Layering

```
FollowUpService (V2, not built)   ← decides WHAT is due
        ↓
NotificationService               ← the abstraction PEPA depends on
        ↓
TelegramProvider                  ← src/lib/providers/telegram.ts
        ↓
Telegram Bot API                  ← src/lib/telegram/client.ts (dumb HTTP)
```

Follow-up logic never imports Telegram. Adding email or push later means
registering another `NotificationService` — nothing above it changes.

### Bot setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → `TELEGRAM_BOT_TOKEN`.
2. Get your own id from `https://t.me/userinfobot` → `TELEGRAM_CHAT_ID`.
3. Register the webhook with a shared secret (see `.env.example`). The webhook
   rejects **every** delivery when `TELEGRAM_WEBHOOK_SECRET` is unset.

### Authorization

Two independent gates, both failing closed:

1. **Webhook delivery** — the `X-Telegram-Bot-Api-Secret-Token` header must
   equal `TELEGRAM_WEBHOOK_SECRET`, compared in constant time.
2. **Owner-only** — the update's chat must equal `TELEGRAM_CHAT_ID`.

Every rejection returns the same plain `{"ok":true}` with no detail, so an
unknown chat cannot learn whether it exists, whether it is the owner, or whether
PEPA is configured. Unrelated update types (polls, edits, commands) are
acknowledged and ignored; `callback_query` is answered and nothing else. No
long-running work happens inside the webhook.

The webhook is a server peer, not a browser: it never touches lead data, so it
cannot bypass PEPA session auth.

### Deep links

```
https://pepa.example.com/followup/fp1_<43 base64url chars>
```

- **Opaque** — 32 cryptographically random bytes behind an `fp1_` prefix. The
  URL contains no lead id, email, subject or body, so `/followup/123` is
  meaningless and leads cannot be enumerated.
- **Hashed at rest** — only `HMAC-SHA256(token)` with domain separation is
  stored in `action_tokens.token_hash`. A database dump cannot be replayed as a
  link. The raw token exists only inside the Telegram button URL.
- **Purpose-scoped** — a `CHECK` constraint limits rows to `followup_composer`.
- **Expiring** — 72 hours by default. An expired token is refused.
- **Still requires a PEPA session.** Tapping the button while signed out sends
  the operator to `/login?next=/followup/<token>`, and login returns them
  straight to the follow-up. Telegram cannot bypass authentication.

Failed resolution (unknown / malformed / expired / wrong purpose) returns one
indistinguishable message, so the page cannot be probed for valid tokens.

Tokens are not single-use: a phone needs to be able to refresh or re-tap the
link. First use is stamped in `used_at` for auditing.

### Database change

`supabase/migrations/20260101000100_action_tokens.sql` adds `action_tokens`
(`id`, `token_hash` unique, `purpose`, `lead_id` FK, `outreach_id` nullable FK,
`created_at`, `expires_at`, `used_at`) with RLS on and no client policies. No
existing table or column changed.

### Testing the channel

A **Test Telegram** button appears in the dashboard when dev tools are enabled
(`NODE_ENV !== production`, or `PEPA_ENABLE_DEV_TOOLS=true`). It calls the
authenticated server action `sendTestTelegramNotification()`, which sends a real
notification for the most recent lead. There is no unauthenticated test endpoint.

---

## Duplicate detection

Deduplication is a **database** guarantee, not a UI check.

1. `normalize_email(text)` is an `IMMUTABLE` SQL function: it unwraps
   `Name <mail>`, trims, strips surrounding punctuation and lowercases. It
   mirrors `normalizeEmail()` in `src/lib/email.ts` — change one, change the other.
2. `leads.email_normalized` is a `GENERATED ALWAYS ... STORED` column computed
   from that function, with `unique (email_normalized)`.
3. `createLead()` inserts with `ON CONFLICT (email_normalized) DO NOTHING` and
   then reads the row back, so two rapid pastes cannot create two leads.
4. `outreach_messages` has the same treatment on
   `(lead_id, recipient_normalized)`, so re-saving a draft updates it instead of
   piling up duplicates.

The browser never queries Supabase. `checkRecipient()` is a server function, so
the badge always reflects what is actually stored.

Statuses:

| Badge                | Condition                                              |
| -------------------- | ------------------------------------------------------ |
| `NEW LEAD`           | no lead row for the normalized address                 |
| `EXISTING LEAD`      | lead exists, `last_contacted_at` is null                |
| `ALREADY CONTACTED`  | last contact date + number of previous messages shown   |

`ALREADY CONTACTED` warns but does not block — reviewing before sending is the
intended workflow.

## Statuses

`draft`, `ready`, `sent`, `replied`, `follow_up`, `completed`, `blocked`
(Postgres enum `public.outreach_status` on both tables).

## What is implemented

- Paste/parse with tolerant label matching (`recipient:` / `To:` / `**Recipient**`
  / `recipient :`, Czech aliases, inline or multiline values, markdown fences,
  blockquotes, `Name <mail>` recipients) and a field preview.
- Server-side duplicate check with the three states above.
- Composer with editable recipient / subject / body, optional company and
  contact, Clear, Save draft, and a Send button that reports that no provider is
  configured yet.
- History table: company/recipient, email, subject, status, last contacted,
  follow-up count, created date, plus an Open button to reload a lead.
- Password login, signed session cookie, protected routes and mutations.
- RLS enabled with no client policies; all traffic goes through the service-role
  server client.

## V2 — seams already in place

| Feature | Where it plugs in |
| ------- | ----------------- |
| Follow-up scheduler | implement `FollowUpService`; `leads.next_followup_at`, `leads.followup_count` and `getLeadOutreachHistory()` already exist. It emits through `NotificationService`, so Telegram is optional |
| Gmail sending | implement `EmailProvider` in `src/lib/providers/`, `registerEmailProvider()`; the Send button already resolves through `getEmailProvider()` |
| Apple Mail | second `EmailProvider` (mailto) in the same registry |
| Reply detection | set lead `status = 'replied'`, fill `outreach_messages.provider_message_id` (already uniquely indexed) |
| Email / push notifications | implement `NotificationService`, `registerNotificationService()` |
| Analytics | `outreach_messages` + `outreach_overview` view are the base |

Persisting a send means writing `provider`, `provider_message_id` and `sent_at`
on the message, then bumping the lead's `last_contacted_at` /
`next_followup_at` — the columns and the check constraint are already in place.

Not built yet, deliberately: the follow-up scheduler itself (including any cron
or Vercel Cron job), automatic follow-up generation, and automatic sending.

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` is imported only from `server-only` modules and is
  never prefixed with `NEXT_PUBLIC_`. Verified absent from `.next/static`.
- RLS is on and no anon/authenticated policy is granted, so the tables are
  unreachable from the browser even if the anon key leaks.
- Server Actions validate and length-limit every input; they are untrusted entry
  points and each one re-checks the session before touching Supabase.
- The session cookie is `HttpOnly`, so client JavaScript cannot read or forge it.
- `safeRedirectPath()` rejects protocol-relative and absolute `?next=` values, so
  the login screen cannot be turned into an open redirect.
- No secret is ever passed to a client component or serialized into props; the
  setup notice reports variable **names** only.
- Rotate `PEPA_SESSION_SECRET` to invalidate every session (e.g. after a
  suspected compromise).

## Deploying to Vercel

1. Import the repository in Vercel (framework preset: Next.js).
2. Add the five environment variables above under **Settings → Environment
   Variables** for Production (and Preview if you want previews to work).
3. Deploy. `npm run build` needs no local-only assumptions — no environment
   variable is read at build time.
4. Optional but recommended: add the deployment to a **Vercel Authentication**
   protection rule (or an access allow-list) as a second lock on top of the
   password, since a password alone is a single factor.

There are no API routes, no cron jobs and no background workers, so nothing
else needs configuring.