# Production deployment & verification

This is the ordered path from an empty Supabase project to a verified PEPA
deployment. **Do not skip step 12** — a green build is not evidence that the app
works against a real database and a real Telegram bot.

PEPA is a single-operator, password-gated app. It has exactly one client (a
browser), one scheduled job (Vercel Cron) and one inbound integration (Telegram).

---

## Before you start

You need:

- A Supabase project (the free tier is sufficient).
- A Vercel account that can import this repository.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- Your Telegram numeric user/chat id (message [@userinfobot](https://t.me/userinfobot)).

Locally: Node 20+, and the Supabase CLI (`npm i -g supabase`) for the
`supabase` commands below. Everything else is `npm`.

```bash
npm ci
```

---

## 1. Create the Supabase project

Supabase dashboard → **New project**. Wait for it to provision, then open
**Project Settings → API** and record:

| Value | Where it goes |
| --- | --- |
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` public key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` |

The `service_role` key bypasses RLS. It is server-only, must never be prefixed
with `NEXT_PUBLIC_`, and must never leave the server. See
`.env.example` for every variable and what generates it.

## 2. Link and push the schema

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

`supabase db push` applies the six migrations in `supabase/migrations/` in
order. They are the only schema source of truth — do not edit the database by
hand.

## 3. Verify the schema

```bash
supabase db query --linked --file supabase/verify-schema.sql
```

This script is read-only and raises an exception naming the first problem. A
correct database reports:

```
 object_type  | found
--------------+-------
 indexes      | 20
 rls_policies | 0
 tables       | 4
 views        | 2
```

`rls_policies` **must be 0**. PEPA talks to the database exclusively through the
service-role key from server code, so it needs no policies; any policy present
means something outside PEPA has write access to the data. `tables = 4` counts
only tables with RLS enabled, so that number is also a second RLS assertion.

`verify-schema.sql` lives in `supabase/` but not in `supabase/migrations/`, so
`supabase db push` will never try to apply it. `db query --linked` routes the
statement through the Management API rather than a direct Postgres connection.
If you prefer a direct connection, `psql` against the linked connection string
works too; pasting the file into **Supabase Studio → SQL Editor** gives an
identical result.

## 4. Set the environment variables

Set all ten required variables in Vercel under **Settings → Environment
Variables**, for **Production** (and Preview if you want previews usable):

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
PEPA_PASSWORD
PEPA_SESSION_SECRET
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET
CRON_SECRET
IMPORT_SECRET
PEPA_BASE_URL
```

`PEPA_PASSWORD` must be at least 12 characters and `PEPA_SESSION_SECRET` at
least 32; the login gate refuses to start without them. `PEPA_BASE_URL` is the
canonical public origin (e.g. `https://pepa.example.com`) and is used to build
Telegram deep links and import review links. Generate secrets with
`openssl rand -base64 32`.

Leave `PEPA_ENABLE_DEV_TOOLS` unset (or `false`) in production. In a production
build the flag has **no effect at all** — `devToolsEnabled()` returns false there
unconditionally, so a mis-set variable cannot switch on the Telegram test sender
— but leave it `false` anyway so the intent is recorded. Outside production the
dev tools are always available; the flag was already inert there too.

**A partial configuration is no longer silent.** `getEnvStatus()` in
`src/lib/config/env.ts` validates all eleven variables, so the dashboard setup
notice reports every missing one **by variable name** — the three
`TELEGRAM_*` variables, `CRON_SECRET`, `IMPORT_SECRET` and `PEPA_BASE_URL`
included, not just Supabase and the two auth secrets. If the dashboard renders
the setup notice instead of the composer, the login page's own notice still
covers only `PEPA_PASSWORD` and `PEPA_SESSION_SECRET`: read the full list off
the dashboard after signing in. No value is ever displayed.

`PEPA_BASE_URL` is required in production, not optional: production deep links
are built only from it and never from a request `Host` header. Without it,
`getBaseUrl()` throws rather than guessing an origin.

For local work, copy `.env.example` to `.env.local` and fill it in. `.env.local`
is gitignored and must never be committed.

## 5. Deploy

Import the repository in Vercel with the **Next.js** framework preset and
deploy. `npm run build` reads no environment variables, so a build cannot fail
because of a missing secret — which also means a green build proves nothing
about configuration. That is what step 12 is for.

Vercel reads `vercel.json` and registers the cron entry automatically:

```json
{ "crons": [ { "path": "/api/cron/followups", "schedule": "0 8 * * *" } ] }
```

**Hobby-plan limitation:** Vercel only allows cron invocations once per day, and
the limit is per deployment, so previews do not get a working follow-up job.
`0 8 * * *` (08:00 UTC daily) is within that limit.

## 6. Add a second lock

PEPA's password is a single factor. Add Vercel **Authentication** protection
(or an IP allow-list) for the production domain so the password is not the only
thing between the internet and the pipeline. Apply it *after* step 12, or you
will lock yourself out mid-verification.

## 7. Register the Telegram webhook

Telegram cannot reach a `localhost` deployment, so this step happens after the
first Vercel deploy, once the production hostname is known.

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="$PEPA_BASE_URL/api/telegram/webhook" \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET"
```

Expected response: `{"ok":true,"result":true,...}`.

Confirm it took:

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

`url` must be the production webhook and `secret_token_set` must be `true`. If
`pending_update_count` stays above 0, the bot is not receiving deliveries and
messages will be missed.

The webhook authenticates with Telegram's `X-Telegram-Bot-Api-Secret-Token`
header, compared in constant time, and fails closed when
`TELEGRAM_WEBHOOK_SECRET` is unset. It deliberately sits outside the PEPA session
gate (see the matcher in `src/proxy.ts`): Telegram is not a browser and has no
PEPA session.

## 8. Sanity-check the deployment

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$PEPA_BASE_URL/login"   # 200
curl -sS "$PEPA_BASE_URL/api/cron/followups"                     # 401
curl -sS -X POST "$PEPA_BASE_URL/api/import"                      # 401
```

The two `401`s are the correct result: both routes fail closed with **401** when
their bearer secret is wrong or unset — they never fall through to a 500. A
`500` means something else broke at runtime; check the Vercel function log.

## 9. Confirm the secrets are set, not just present

Sign in at `$PEPA_BASE_URL/login`. The dashboard must load real data. If it
shows the setup notice, one of the required variables is missing or empty.

Then confirm no server-only value reached the client bundle. Export the values
from a trusted source first — an unset variable would expand to an empty
pattern and match every file, which looks like a leak but is a false alarm:

```bash
export PEPA_SESSION_SECRET="..." SUPABASE_SERVICE_ROLE_KEY="..."
npm run build

for var in PEPA_SESSION_SECRET SUPABASE_SERVICE_ROLE_KEY TELEGRAM_BOT_TOKEN \
           CRON_SECRET IMPORT_SECRET; do
  if grep -rqF "$var"=.next/static 2>/dev/null; then
    echo "LEAK: $var appears in .next/static"
  fi
done
```

A build that emits no `LEAK:` line is the expected result. Any `LEAK:` line
means a server-only value reached the browser: rotate that secret immediately,
then find the import that pulled it in.

You can also grep for the *variable names* rather than values, which needs no
secrets in your shell:

```bash
grep -rlE "SUPABASE_SERVICE_ROLE_KEY|PEPA_SESSION_SECRET|CRON_SECRET|IMPORT_SECRET|TELEGRAM_BOT_TOKEN" .next/static
```

That must print nothing either.

## 10. Local regression gate

Before touching production data, confirm the tree is green:

```bash
npm run lint
npm run typecheck
npm run test      # full suite, must be green
npm run build
git status --short   # must be clean
```

## 11. Import one real lead

`POST /api/import` is how an email drafted outside PEPA enters the system. It
creates **drafts**; nothing is ever sent automatically.

```bash
curl -sS -X POST "$PEPA_BASE_URL/api/import" \
  -H "Authorization: Bearer $IMPORT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
        "recipient": "Real.Address@Example.com",
        "subject": "AI recepce pro Example",
        "body": "Dobrý den,\n\nchtěl jsem Vám ukázat...",
        "companyName": "Example s.r.o.",
        "contactName": "Real Address"
      }'
```

The payload shape is `OutreachImportInput` from
`src/lib/import/outreach-import.ts`: `recipient`, `subject` and `body` are
required; `companyName` and `contactName` are optional. The recipient is
normalised server-side, so `Real.Address@Example.com` is stored as
`real.address@example.com`. Wrong field names are rejected with `400`, not
ignored.

Expected: a short-lived opaque `deep_link`, never the payload and never a lead
id. `status` reports `created`, `refreshed` or `already_contacted`, and
`already_contacted` is the expected result when you re-import a lead you have
already messaged. Open the link, confirm the lead appears as a **draft** with the
normalised email, then delete it or mark it appropriately.

A wrong or missing `IMPORT_SECRET` must return `401`. Imported tokens are stored
as SHA-256 digests with a 30-minute TTL under purpose `outreach_import` — the
same table and the same token model as composer links, not a second system.

## 12. Real Telegram end-to-end (mandatory)

This is the step that cannot be faked with a mock. It proves the notification
path against a real bot token, and it is a release gate.

> **This gate is reachable now.** The chain below starts from a message that
> actually left the outbox (`outreach_messages.sent_at` set). Send recording
> exists: the composer's **Mark as sent** action calls
> `recordOutreachSent()` in `src/lib/services/outreach-service.ts`, which runs
> the authoritative quality gate, writes `status = 'sent'` with `sent_at`, and
> then calls `markFollowUpSent()` to arm `next_followup_at`. Step 2 below is
> that button. Submitting it twice is safe — the second call reports
> `already_sent` and schedules nothing further.
>
> The rest of the chain is still unproven until you run it against a real bot
> token, and **PEPA is not production-verified until you do**. No local test,
> rehearsal or green build substitutes for this: a working
> `/api/cron/followups` returning `{"ok":true}` with `examined: 0` means the
> engine found nothing because nothing was ever due — not that the chain works.

1. Create a lead with your real email and save a composer draft, so the lead and
   its outreach message exist.
2. Record that the outreach actually went out, so `outreach_messages.sent_at`
   is set and the message status is `sent`. This is the composer's **Mark as
   sent** button. PEPA never sends mail itself: send from your own client
   first, then record the fact.
3. Ensure the lead has a `next_followup_at` in the past, so it is due.
4. Trigger the job by hand with the real secret, or wait for the scheduled run:
   ```bash
   curl -sS "$PEPA_BASE_URL/api/cron/followups" \
     -H "Authorization: Bearer $CRON_SECRET"
   ```
   `examined` must be at least 1 and `notified` must be at least 1. All zeros
   means the engine is inert, not that there was nothing to do.
5. The Telegram notification arrives on your phone within seconds. It shows the
   lead name, the email, the follow-up number and the last-contact date. It must
   **never** contain the subject or the body of the email.
6. The message carries exactly one inline button: **OPEN IN PEPA**. That is the
   only button PEPA renders. There are no Done / Snooze / Cancel buttons and no
   reply detection.
7. Tap **OPEN IN PEPA**. If you are not signed in you land on
   `/login?next=/followup/<token>`; after signing in you return to the **same**
   follow-up.
8. Confirm the page shows the **correct** lead and the **correct** message — not
   another lead, and not an empty composer.
9. Save a change and confirm it persists to that lead's draft.
10. Confirm the ledger holds exactly one row for this follow-up, by name only:
    ```sql
    select lead_id, followup_number, status, sent_at
    from public.followup_notifications
    order by created_at desc limit 5;
    ```
    There must be exactly one row with `status = 'sent'` for that
    `(lead_id, followup_number)`.
11. Run the cron endpoint again with the real secret. `notified` must be `0` and
    **no second Telegram message may arrive**. This is the duplicate-notification
    gate.
12. Confirm an unauthorised chat id is rejected: the webhook authorises exactly
    one chat, and no other chat can receive or post.
13. Confirm the cron route rejects a bad secret in constant time, and that
    **notifications do not advance `next_followup_at`** — only a real send does.
    A follow-up firing on schedule after a notification alone is a bug.
14. Check the Vercel dashboard → **Logs → Cron** for the next scheduled run.
    Vercel attaches the same `Authorization: Bearer $CRON_SECRET` header
    automatically, so a manual call with the secret must be indistinguishable
    from a scheduled one.

Record what you observed. If any step above cannot be performed, PEPA is **not**
production-verified — say so rather than reporting a green build.

## 13. Operate

- **Follow-up cadence** is 4/7/10 days after the last actual outreach send.
- **Idempotency** is enforced by `UNIQUE (lead_id, followup_number)`, so a
  retried or duplicated cron run cannot double-message a lead.
- **Claims** use a 30-minute lease. A send that succeeds while bookkeeping fails
  deliberately keeps the claim, so the lead is never messaged twice at the cost
  of one missed follow-up. This is the intended trade.
- **Rotating `PEPA_SESSION_SECRET`** invalidates every session immediately.
- **Rotating `IMPORT_SECRET` or `CRON_SECRET`** only invalidates those callers;
  no data changes.
- Re-run `supabase/verify-schema.sql` after any manual database change.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Login page shows a setup notice | A required variable is missing or empty | Check Vercel env vars by **name** |
| `/api/cron/followups` or `/api/import` returns 401 | Wrong or missing bearer secret, or the secret is not set at all | Set `CRON_SECRET` / `IMPORT_SECRET`. Both routes fail closed with **401**, never 500 |
| No Telegram notifications | Webhook not registered, or `TELEGRAM_BOT_TOKEN` wrong | Re-run step 7, check `getWebhookInfo` |
| Telegram notifications arrive from the wrong sender | Bot token belongs to a different bot | Re-issue via @BotFather, redeploy |
| Deep links open the wrong host | `PEPA_BASE_URL` unset and request host used | Set `PEPA_BASE_URL` to the canonical origin |
| Import returns 401 | Wrong or missing bearer | Use `$IMPORT_SECRET` exactly |
| Cron never runs | Hobby plan limits crons to daily | `0 8 * * *` is fine; check the Logs → Cron tab |
| `getBaseUrl()` resolves to localhost | `PEPA_BASE_URL` not set on the deployment | Set it explicitly |
