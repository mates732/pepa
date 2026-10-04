# ChatGPT → PEPA → Gmail

How an email written in a ChatGPT conversation reaches a Gmail compose window
without anything ever being sent automatically.

```
ChatGPT (or any HTTP client)
  │  POST https://pepa-rho.vercel.app/api/import
  │  Authorization: Bearer <IMPORT_SECRET>
  │  { "recipient": "...", "subject": "...", "body": "...", ... }
  ▼
PEPA validates → stores an ordinary DRAFT → mints an opaque one-time-purpose token
  │  { "deep_link": "https://pepa-rho.vercel.app/import/fp1_<43 chars>", ... }
  ▼
"Open in PEPA ↗"  ← the operator clicks this
  │
  ▼
/import/<token>   → login if needed → resolves the token server-side
  │                 shows the exact prepared draft
  ▼
"Open in Gmail ↗" → Gmail compose: recipient + subject + body
  │
  ▼
THE OPERATOR PRESSES SEND.  ← the only step that sends anything
```

## What already existed, and what was added

Everything except the last hop was already in PEPA and is **unchanged** by the
deep-link work:

| Piece | Where | Status |
| --- | --- | --- |
| Import endpoint, `Bearer IMPORT_SECRET` | `src/app/api/import/route.ts` | existing |
| Payload validation + limits | `src/lib/import/outreach-import.ts` | existing |
| Draft storage, dedupe, token minting | `src/lib/services/import-service.ts` | existing |
| Opaque `fp1_…` token, HMAC-hashed at rest, TTL, purpose binding | `src/lib/deep-link/tokens.ts`, `action_tokens` | existing |
| Landing page, session gate, editor | `src/app/import/[token]/page.tsx` | existing |
| **“Open in Gmail” on the imported draft** | `src/app/import-actions.ts` → `openImportInGmail`, `src/components/gmail-compose-button.tsx` | **added** |

**No new token system. No new database table. No migration.** The deep link uses
the `outreach_import` purpose that already existed, so a follow-up token and an
import token remain non-interchangeable.

## Deep-link shape

```
https://pepa-rho.vercel.app/import/fp1_<43 base64url characters>
```

The URL contains **nothing but a random token**. It carries no recipient, no
subject, no body, no phone number, no Supabase id and no credential. Recipient,
subject and body are resolved server-side from the token's HMAC digest, so
`/import/1` cannot be used to probe for leads and no outreach content ever
reaches a URL, a referrer or a server log line.

## Token security model

- **Opaque.** 32 random bytes, base64url, `fp1_` prefix so a leaked token is
  identifiable and purpose-scannable. Nothing about the lead is encoded in it.
- **Hashed at rest.** Only `HMAC-SHA256(PEPA_SESSION_SECRET, "pepa:action-token:v1:" + token)`
  is stored. HMAC rather than a bare hash, so someone holding the whole table
  still cannot confirm a guessed token. The digest is domain-separated from the
  session cookie, so a token digest can never be mistaken for or used to forge a
  session.
- **Purpose-bound.** `outreach_import` vs `followup_composer`. Resolution filters
  on the purpose, so a token minted for one flow cannot be replayed in the other.
- **Finite TTL.** 30 minutes (`IMPORT_TOKEN_TTL_MS`) — deliberately shorter than
  the 72 h follow-up link, because an import is reviewed immediately.
- **Session required.** `/import/<token>` calls `verifySession()`, and
  `openImportInGmail` calls `requireAuthenticatedUser()` before touching the
  database. Anonymous access yields a redirect to `/login?next=…`, after which
  the operator returns to the same link.
- **Indistinguishable failures.** Malformed, unknown, expired and wrong-purpose
  tokens all return the same message, so the endpoint is not an oracle.
- **Re-openable within the TTL.** First use is stamped in `used_at` as an audit
  trail, but consuming the link does not destroy the draft — opening it twice
  shows the same draft, and creating nothing.

## Why the browser cannot forge the email

`openImportInGmail` receives **only a token**. The browser never sends a
recipient, subject, body, message id or lead id.

The recipient, subject and body are read from the stored `outreach_messages`
row and turned into a URL by `buildGmailComposeUrl`, the same service the
dashboard uses. So the values Gmail receives are exactly what PEPA stored, and
no value rendered on the page can influence them. A crafted request can at most
ask PEPA to re-read a draft it already had.

The Gmail URL is built the same gesture-safe way as everywhere else:
`preopenComposeWindow()` reserves a blank tab **synchronously inside the click**,
and only then awaits the server and navigates that tab — so the popup blocker
accepts it. This is the fix from `d0bc696`, reused rather than reimplemented.

## Nothing here sends email

- The import lands in `outreach_messages` with `status = 'draft'` and
  `sent_at IS NULL`.
- `openImportInGmail` is a **read**: no update, no status change, no counter.
- Gmail opens a compose window. The operator presses Send.
- PEPA has no Gmail API, no OAuth and no credential of any kind. It never learns
  whether — or whether at all — the email was sent. That is recorded solely by
  the explicit, quality-gated “Mark as sent” action.
- The Gmail button is refused outright for a message that is no longer an open
  draft, so an import link cannot be used to reopen an email that already went out.

## How to actually get the link out of ChatGPT — the part still missing

**ChatGPT cannot mint a PEPA link by itself, and this repository does not pretend
otherwise.** The only credential the import endpoint accepts is `IMPORT_SECRET`,
a server-side bearer secret. Handing it to a ChatGPT conversation, a custom GPT,
or anything the model can read would publish it, and anyone holding it could
import drafts into PEPA.

So the honest architecture has a bridge:

```
ChatGPT conversation
  │  produces recipient / subject / body
  ▼
bridge  ← THE MISSING PIECE
  │  holds IMPORT_SECRET server-side; never in a prompt
  ▼
POST /api/import  →  { deep_link }
  │
  ▼
reply to the operator with "Open in PEPA ↗"
```

The bridge only has to make one authenticated POST and echo back the
`deep_link`. Any of these satisfies it, in rough order of effort:

1. **The operator runs it.** Paste the payload and run the `curl` below, or keep
   using the existing Paste-import UI. Zero new infrastructure, and it is what
   works today.
2. **An automation runner** (n8n, Make, Zapier) holding `IMPORT_SECRET` as a
   credential, triggered by whatever ChatGPT surface you use.
3. **A tiny serverless function** (Cloudflare Worker, Vercel function) that owns
   the secret and exposes only the deep link.
4. **A ChatGPT Action / custom GPT** pointing at one of the above. Note the
   action's own endpoint must not expose `IMPORT_SECRET` to the model; the
   action calls the bridge, and the bridge calls PEPA.

Regardless of which bridge you pick, the contract with PEPA does not change:

```bash
curl -sS https://pepa-rho.vercel.app/api/import \
  -H "Authorization: Bearer $IMPORT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "recipient": "katy@beautysalon.cz",
    "subject":   "AI recepce pro Beautysalon v Průhonicích",
    "body":      "Dobrý den, paní Klimentová,\n\n…\n\nDíky, Pavel",
    "companyName": "Beautysalon",
    "contactName": "Kateřina Klimentová"
  }'
```

```json
{
  "ok": true,
  "deep_link": "https://pepa-rho.vercel.app/import/fp1_…",
  "recipient": "katy@beautysalon.cz",
  "status": "created",
  "expires_at": "2026-10-04T20:31:00.000Z"
}
```

`status` is `created`, `refreshed` (an open draft for that recipient already
existed and was updated in place — importing is idempotent) or a `409` with
`already_contacted` when the recipient has genuinely been written to.

Repeat calls for the same recipient never pile up drafts: the write is an upsert
on the unique `(lead_id, recipient_normalized, sequence_number)` key.

## Failure modes

| Situation | Result |
| --- | --- |
| No `Authorization` header, or a wrong secret | `401 Unauthorized` |
| Malformed JSON, missing recipient, over the size limit | `400` / `413` |
| Recipient already contacted | `409`, draft untouched |
| Link older than 30 minutes | “This link is invalid or has expired.” |
| Token minted for the follow-up flow | same message — the purposes are not interchangeable |
| Draft already sent | “This message has already been sent…” |
| Operator not signed in | redirect to `/login?next=…`, then straight back |
| Browser blocks the popup | the button says so and prints the URL to open manually |
