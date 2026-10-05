# Historical outreach import

PEPA can no longer start a cold outreach to an address the previous business
account already pitched. This document describes where that history lives, how
the guard decides, and how to re-run the import.

## What was imported

`pepa_outreach_history_detailed.csv` — 330 unique addresses from the legacy
outreach account, imported on 2026-10-05.

```
npm run import:historical-outreach              # dry run: parse and report
npm run import:historical-outreach -- --apply   # write
```

The import is **dry run by default**, **idempotent**, and has **no delete path**.
Running it a second time inserts nothing and reports `new addresses: 0`.

## Where the data lives

| Table | What it holds | Changed by the import |
| --- | --- | --- |
| `historical_outreach` | the imported aggregate, one row per normalized address | **written** (330 rows) |
| `outreach_messages` | Pep-generated messages | **untouched** |
| `leads` | Pep-created leads | **untouched** |

No `outreach_messages` rows were created, because none could be created
honestly. The export is an **aggregate**: `contact_count` does not equal the
number of subjects in 300 of its 330 rows (one address has 143 contacts and 45
subjects), and it carries no per-message timestamp, lead id, sequence number or
provider message id. Inventing them would fabricate a send history — and
writing one row per address would occupy `sequence_number = 0`, the slot the
composer upserts into, so saving a draft would silently overwrite the import.

`historical_outreach` is therefore a record of what the previous account did, not
a place to write messages. `outreach_messages` remains the only record of a real
email.

## Identity

Two levels, and only two:

1. **Exact normalized address** — `normalizeEmail()` in `src/lib/email.ts`,
   mirrored by `public.normalize_email`. This is the primary key.
2. **Normalized company domain** — `normalizeDomain()` in
   `src/lib/outreach/domain.ts`, mirrored by `public.normalize_domain`. A second
   mailbox at a company that has already been pitched is still a second pitch to
   that company.

Company name is never an identity.

Shared mailbox providers (`gmail.com`, `outlook.com`, `seznam.cz`, …) **never**
produce a domain-level block: `owner1@gmail.com` and `owner2@gmail.com` are
different businesses. The rule lives in one place,
`isSharedEmailProviderDomain()`, and is also enforced in the database by the
generated `historical_outreach.is_shared_provider` column, so a future caller
cannot forget it. Of the 330 imported rows, 56 are provider mailboxes and 274
are company domains.

Both normalizations are applied by **generated columns**, so the stored identity
can never disagree with the lookup that reads it. Every spelling of one address
— `Info@Bistro.CZ`, `  info@bistro.cz  `, `<info@bistro.cz>` — resolves to the
same row.

## Where the hard stop lives

`evaluateStoredMessageQualityGate()` in
`src/lib/services/outreach-quality-gate.ts`, which is called by
`recordOutreachSent()` **before** the database write, inside the send
transition. That placement is the point: the draft is re-read from Postgres and
re-checked at the moment of the write, so a stale dashboard, a replayed action
call or a hand-crafted POST cannot record a blocked draft as sent.

```
server action recordOutreachSent()        src/app/actions.ts
  └─ requireAuthenticatedUser()           proves who is asking
  └─ recordOutreachSent()                 src/lib/services/outreach-service.ts
       └─ evaluateStoredMessageQualityGate()   ← the guard, before the write
            ├─ outreach_messages          existing Pep-generated history
            └─ historical_outreach        imported legacy history
```

A refusal is reported as:

```
Cannot send outreach: this email address was already contacted on 2026-09-18.
```

with the machine reason `ALREADY_CONTACTED` (or `ALREADY_CONTACTED_DOMAIN` for a
company-level match), returned on `outcome: "blocked"` / `blockReason`.

**A database error stops the send.** If the history cannot be read, the gate
throws rather than reporting "nothing on record" — failing open would be the one
behaviour this guard exists to prevent.

## Permanent for first contact, finite for follow-ups

This is the one product decision worth stating plainly.

- A **new cold outreach** (`sequence_number = 0`) to an address already on
  record is refused **permanently**, however old the contact is. Age is not a
  defence: every imported contact older than the 3-day cooldown would otherwise
  become pitchable again, which would leave ~300 of the 330 unprotected.
- A **follow-up** (`sequence_number > 0`) inside a sequence Pepa is already
  running is **not** permanently blocked. It is governed by the existing finite
  rules — the 3-day `CONTACT_COOLDOWN_DAYS` cooldown and the 4/7/10 follow-up
  cadence — exactly as before.

So the import does not turn a finite cooldown into an infinite block: it adds a
permanent guard on *first* contact and leaves every existing cadence untouched.

Historical `last_contact` also enters the cooldown arithmetic as a fallback for
`leads.last_contacted_at`, so it counts exactly like a Pep-generated contact and
is never reset because it was imported.

## What the operator sees

`DuplicateCheckResult` (from `checkRecipient()`) carries `canContact`,
`blockReason`, `lastContactedAt` and `historicalContact`, and the composer's
badge renders:

> **ALREADY CONTACTED** · info@bistro.cz · Bistro
> Already contacted · Last contacted: 18 Sept 2026 · Contacts: 3 — a new cold
> outreach to this address is blocked.

The UI is **informational only**. There is no control to dismiss or override the
state, and a lead is never marked contacted by hand — the backend refuses the
send regardless of what the badge says.

## Guarantees

- **Idempotent.** `UNIQUE (email_normalized)` is the guarantee; the importer also
  skips addresses already present. Verified by running the import twice.
- **Non-destructive.** No `DELETE` exists in the importer. Existing rows are
  never updated, so a re-run cannot rewrite history.
- **All-or-nothing.** Any unusable row is reported with its line number and stops
  the run. Importing 329 of 330 would leave one address silently unprotected.
- **Fail-closed.** An unreadable `historical_outreach` aborts the send.
- **Schema-gated.** `supabase/verify-schema.sql` asserts the table, RLS, the
  unique constraint, the generated columns, the SQL↔TypeScript parity of both
  normalisation functions, and that no provider domain is unflagged.

## Tests

`src/lib/services/historical-contact-guard.test.ts`,
`src/app/actions.historical-guard.test.ts`,
`src/lib/outreach/domain.test.ts`,
`src/components/duplicate-notice.historical.test.tsx`.

The send-path tests call `recordOutreachSent()` — the function that can turn a
draft into a recorded send — and then read the store back, rather than calling
the gate in isolation. A test that called the gate alone would still pass if
somebody moved the check out of the send transition.