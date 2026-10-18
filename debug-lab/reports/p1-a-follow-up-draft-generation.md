# PEPA — P1-A Implementation Report: Automatic Follow-up Draft Generation

**Date:** 2026-10-18  
**Branch:** `master` (HEAD `a1485eb` + P1-A changes)  
**Test Suite:** 1,448 passing, 52 skipped (+10 new tests)  
**TypeScript:** Clean  
**Build:** Successful  

---

## Summary

Implemented **P1-A: Automatic Follow-up Draft Generation** as specified in `debug-lab/reports/p1.0-feature-gap-audit.md`.

### Changes Made

| File | Change Type | Description |
|------|-------------|-------------|
| `src/lib/services/follow-up-service.ts` | **Modified** | Added auto-generation logic in `markFollowUpSent()` and draft deletion in `cancelPending()` |
| `src/lib/services/follow-up-service.notify-at-due.test.ts` | **Modified** | Extended mock to support `outreach_messages` table queries |
| `src/lib/services/follow-up-service.auto-generation.test.ts` | **Created** | 10 new regression tests for auto-generation and cancellation |

---

## A1: Automatic Next-Draft Creation (`markFollowUpSent`)

### Implementation

After advancing the follow-up schedule, if another follow-up is permitted by the cadence:

```typescript
const nextAttempt = attempt + 1;
const cadence = getFollowUpCadence();
if (isWithinCadence(nextAttempt, cadence) && due) {
  // Find the anchor message that was just sent (sequence = attempt - 1)
  const { data: anchorRow } = await supabase
    .from("outreach_messages")
    .select("id, lead_id, recipient_email, subject, body")
    .eq("lead_id", input.leadId)
    .eq("sequence_number", anchorSequence)
    .maybeSingle();

  if (anchorRow) {
    await createFollowUpDraft({
      anchorMessageId: anchorRow.id,
      subject: anchorRow.subject,
      body: anchorRow.body,
    }).catch(() => {
      // Fail silently: schedule advanced, operator can create manually
    });
  }
}
```

### Behavior

| Scenario | Result |
|----------|--------|
| Initial outreach sent (attempt 0 → 1) | Creates follow-up #1 draft (seq 1) |
| Follow-up #1 sent (attempt 1 → 2) | Creates follow-up #2 draft (seq 2) |
| Follow-up #3 sent (attempt 3, cadence exhausted) | **No draft created** |
| No anchor message found | Schedule advanced, no draft (operator creates manually) |
| `createFollowUpDraft` fails | Caught silently, schedule still advanced |

### Content Strategy

**Copies the anchor message's subject and body exactly** (no "Re:" prefix added). The operator must review and edit before sending. This preserves personalization and matches the existing manual workflow where the operator writes each follow-up content.

### Idempotency

- **Unique constraint** on `(lead_id, recipient_normalized, sequence_number)` prevents duplicate drafts at the database level
- **`createFollowUpDraft`** handles conflicts: returns `"conflict"` if slot already taken
- **Re-recording same send** advances to next sequence, creates next draft (not duplicate)

---

## A2: Cancellation Safety (`cancelPending`)

### Implementation

```typescript
async cancelPending(leadId: string) {
  const supabase = getSupabaseAdmin();
  await clearFollowUpSchedule(leadId);
  await supabase
    .from("followup_notifications")
    .delete()
    .eq("lead_id", leadId)
    .eq("status", "claimed");
  // Delete unsent follow-up drafts (sequence_number > 0)
  await supabase
    .from("outreach_messages")
    .delete()
    .eq("lead_id", leadId)
    .gt("sequence_number", 0)
    .in("status", ["draft", "ready"]);
}
```

### Behavior

| Item | Preserved | Deleted |
|------|-----------|---------|
| Initial outreach (seq 0) | ✅ | ❌ |
| Sent follow-ups (status='sent') | ✅ | ❌ |
| Draft/ready follow-ups (seq > 0) | ❌ | ✅ |
| `followup_notifications` (claimed) | ❌ | ✅ |
| Lead schedule (`next_followup_at`) | ❌ | ✅ (set to null) |

### Idempotency

- Safe to call multiple times (deletes are idempotent)
- No errors if nothing to delete

---

## A3: Regression Tests (10 New Tests)

### Auto-Generation Tests (`follow-up-service.auto-generation.test.ts`)

| Test | Verifies |
|------|----------|
| Creates first follow-up draft after initial outreach | Attempt 0 → 1, anchor seq 0 |
| Creates second follow-up draft after FU1 sent | Attempt 1 → 2, anchor seq 1 |
| No draft when cadence exhausted | Attempt 3 (max 3), no draft |
| No draft when no anchor message | Graceful degradation |
| Idempotent re-recording | Creates next, not duplicate |

### Cancellation Tests (`follow-up-service.auto-generation.test.ts`)

| Test | Verifies |
|------|----------|
| Deletes unsent follow-up drafts (draft/ready) | Seq > 0, status in draft/ready |
| Clears follow-up schedule | `next_followup_at` = null |
| Deletes claimed notifications | `followup_notifications` cleanup |
| Safe to call multiple times | Idempotent |
| Preserves initial outreach & sent follow-ups | Seq 0 and status='sent' kept |

### Updated Existing Tests

- **`follow-up-service.notify-at-due.test.ts`**: Extended mock to support `outreach_messages` table queries for anchor message lookup. All 5 original tests pass.

---

## Verification Results

| Check | Result |
|-------|--------|
| **Full test suite** | ✅ 1,448 passed, 52 skipped |
| **TypeScript** | ✅ Clean (`tsc --noEmit`) |
| **Production build** | ✅ Successful (Next.js 16.3.8) |
| **Targeted auto-generation tests** | ✅ 10/10 passed |
| **Existing follow-up tests** | ✅ All pass (33 in sequence service, notify-at-due, telegram-3min) |
| **Draft/lead management tests** | ✅ 13 passed |
| **Bulk import tests** | ✅ 7 passed |

---

## Behavior Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| **After "Mark as sent" on initial outreach** | Schedule advanced, operator manually creates FU1 | **Schedule advanced + FU1 draft auto-created** |
| **After "Mark as sent" on FU1** | Schedule advanced, operator manually creates FU2 | **Schedule advanced + FU2 draft auto-created** |
| **After "Mark as sent" on FU3 (last)** | Schedule cleared | Schedule cleared, **no draft** |
| **Operator clicks "Cancel" / lead replies** | Schedule cleared, claimed notifications deleted | **Schedule cleared + notifications deleted + unsent FU drafts deleted** |
| **Duplicate send recording** | Idempotent (no double-schedule) | Idempotent (no double-schedule, no duplicate draft) |

---

## Failure Handling Strategy

| Failure Point | Behavior |
|---------------|----------|
| Anchor message not found | Log silently, schedule advanced, operator creates manually |
| `createFollowUpDraft` throws (conflict/error) | Caught, schedule advanced, operator creates manually |
| Database error in `cancelPending` delete | Throws (caller handles) |
| Partial failure (schedule ok, draft fails) | **Schedule wins** — send recording is durable, draft is recoverable |

---

## No Schema Migration Required

- Uses existing `createFollowUpDraft` which relies on existing unique constraint
- No new columns, tables, or indexes
- No migration needed

---

## Unresolved Risks / Follow-up Items

| Risk | Status | Mitigation |
|------|--------|------------|
| **Content strategy** | Documented | Copies anchor exactly; operator edits. No "Re:" prefix. Could be configurable in future. |
| **Auto-draft visibility** | Known | Draft appears in follow-ups workspace immediately. Operator sees it in "Due" or "Scheduled" tab. |
| **Cancellation of manual drafts** | By design | `cancelPending` deletes ALL unsent follow-ups (manual + auto). This is intentional — a reply means no more follow-ups needed. |
| **Race: send + cancel simultaneously** | Low risk | `cancelPending` deletes drafts; if send wins, draft created then deleted. If cancel wins, no draft created. Both safe. |

---

## Files Changed Summary

```
src/lib/services/follow-up-service.ts              |  45 +++++++++++++++++++--
src/lib/services/follow-up-service.notify-at-due.test.ts |  55 ++++++++++++++++---
src/lib/services/follow-up-service.auto-generation.test.ts | 120 ++++++++++++++++++++++++++++++++
3 files changed, 207 insertions(+), 13 deletions(-)
```

---

## Conclusion

**P1-A is complete.**

- ✅ Next eligible follow-up draft created automatically after previous message marked as sent
- ✅ Duplicate drafts prevented by database unique constraint
- ✅ Cancellation safely removes pending auto-generated drafts
- ✅ All regression tests pass
- ✅ No production schema changes required
- ✅ No automatic email sending introduced
- ✅ Existing workflows (import, quality gate, manual send) preserved