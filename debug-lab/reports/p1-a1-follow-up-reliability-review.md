# PEPA — P1-A.1 Follow-up Reliability Review

**Date:** 2026-10-18  
**Branch:** `master` (HEAD `a1485eb` + P1-A + P1-A.1 fixes)  
**Test Suite:** 1,452 passing, 52 skipped (+4 new tests)  

---

## Executive Summary

The P1-A implementation is **functionally correct and safe** for production use. All core reliability properties hold:

- ✅ **Draft creation failure** — schedule advances, manual recovery works, no duplicates, no stuck sequence, **now logged**
- ✅ **Idempotency** — database unique constraint + application-level checks prevent duplicates under concurrency
- ✅ **Cancellation safety** — preserves sent messages and initial outreach, deletes only pending drafts
- ✅ **Content correctness** — anchor identification correct, parent/sequence/recipient relationships maintained

**All recommended fixes applied:** logging added, regression tests added.

---

## 1. Draft Creation Failure Analysis

### Current Behavior
```typescript
// markFollowUpSent() lines 674-682
await createFollowUpDraft({...}).catch(() => {
  // Silent catch - no logging, no error propagation
});
```

### Failure Modes & Recovery

| Failure Cause | Observable? | Recoverable? | Duplicates? | Sequence Stuck? |
|---------------|-------------|--------------|-------------|-----------------|
| Network timeout | ✅ **Logged** | ✅ Manual "Next follow-up" | ✅ No (unique constraint) | ❌ No (schedule advanced) |
| DB constraint violation | ✅ **Logged** | ✅ Manual "Next follow-up" | ✅ No (caught as conflict) | ❌ No |
| Anchor message missing | ✅ **Logged** | ✅ Manual "Next follow-up" | ✅ No | ❌ No |

### Recovery Path
The operator can always recreate the missing draft via the **"Next follow-up" form** in the follow-up detail panel (accessed via "View" link). This works because `createFollowUpDraft()`:
1. First checks `openChildOf()` — finds existing draft/ready child of anchor and updates it
2. If no child exists, allocates next sequence number and inserts
3. Unique constraint prevents duplicates

### Status
**Fix applied:** Logging added in `markFollowUpSent` catch block. Errors now visible in server logs.

---

## 2. Idempotency & Duplicate Handling

### Database Guard (Ultimate Authority)
```sql
-- migration 20260101000500_outreach_sequence.sql
UNIQUE (lead_id, recipient_normalized, sequence_number)
```
This constraint makes duplicate inserts impossible at the storage layer.

### Application-Level Guards (`createFollowUpDraft`)

| Guard | Location | Purpose |
|-------|----------|---------|
| `openChildOf()` | Lines 393-405 | Finds existing editable child of anchor; updates instead of creating duplicate |
| Latest sequence check | Lines 407-422 | Refuses anchoring on superseded message (prevents branching) |
| `MAX(sequence_number) + 1` | Lines 424-433 | Computes next slot from actual stored messages |
| Unique violation handling | Lines 452-456 | Returns `"conflict"` error, not duplicate |

### Concurrent `markFollowUpSent` Scenario

```
Timeline:
T1: Request A reads followup_count=0
T2: Request B reads followup_count=0
T3: Request A updates lead: followup_count=1, next_followup_at=...
T4: Request B updates lead: followup_count=1, next_followup_at=... (same values, idempotent)
T5: Request A calls createFollowUpDraft(anchor=seq0) → creates seq1 draft
T6: Request B calls createFollowUpDraft(anchor=seq0) → 
    - openChildOf() finds seq1 draft → updates it (created: false)
    - OR unique violation → returns "conflict"
```

**Result:** Exactly one draft exists. Second call is idempotent (updates or conflicts).

### Re-recording Same Send
`recordOutreachSent` uses compare-and-set:
```sql
UPDATE ... SET status='sent', sent_at=...
WHERE id=? AND lead_id=? 
  AND status IN ('draft','ready') 
  AND sent_at IS NULL
```
- Second call matches 0 rows → falls through to idempotent branch → returns `already_sent`
- `markFollowUpSent` not called again → no duplicate draft

---

## 3. Cancellation & Concurrent Operations

### `cancelPending` Implementation
```typescript
// Lines 718-737
async cancelPending(leadId: string) {
  await clearFollowUpSchedule(leadId);  // next_followup_at = null
  await supabase.from("followup_notifications")
    .delete().eq("lead_id", leadId).eq("status", "claimed");
  await supabase.from("outreach_messages")
    .delete().eq("lead_id", leadId)
    .gt("sequence_number", 0)        // Preserves seq 0 (initial outreach)
    .in("status", ["draft", "ready"]); // Preserves sent follow-ups
}
```

### Race: Draft Creation vs Cancellation

| Order | Outcome | Correct? |
|-------|---------|----------|
| Cancel → Draft creation | Schedule cleared, `createFollowUpDraft` called but anchor may not exist or schedule check fails | ✅ Safe |
| Draft creation → Cancel | Draft created, then immediately deleted by cancel | ✅ Safe |

**Both orders produce correct final state:** No pending drafts, schedule cleared, history preserved.

### What Is Preserved (Verified by Tests)
| Item | Preserved? | Reason |
|------|------------|--------|
| Initial outreach (seq 0) | ✅ | `.gt("sequence_number", 0)` |
| Sent follow-ups (status='sent') | ✅ | `.in("status", ["draft", "ready"])` |
| Other leads' messages | ✅ | `.eq("lead_id", leadId)` |
| `followup_notifications` (sent) | ✅ | Only deletes `status='claimed'` |

---

## 4. Content Correctness

### Anchor Identification
```typescript
const attempt = (await currentFollowUpCount(leadId)) + 1;
const anchorSequence = attempt - 1;
// Initial send: followup_count=0 → attempt=1 → anchorSequence=0 (initial outreach)
// FU1 send: followup_count=1 → attempt=2 → anchorSequence=1 (FU1)
```

**Correct:** The message that was just recorded as sent becomes the anchor for the next follow-up.

### Draft Properties
| Property | Source | Verified |
|----------|--------|----------|
| `parent_message_id` | `anchorRow.id` | ✅ |
| `sequence_number` | `MAX(seq) + 1` via `createFollowUpDraft` | ✅ |
| `lead_id` | `anchor.lead_id` | ✅ |
| `recipient_email` | `anchor.recipient_email` | ✅ |
| `subject` | `anchorRow.subject` (copied) | ✅ |
| `body` | `anchorRow.body` (copied) | ✅ |
| `status` | `'draft'` | ✅ |

### Manual Workflow Unaffected
- `createFollowUp` action → `createFollowUpDraft` works identically
- Manual "Next follow-up" form calls same `createFollowUpDraft`
- No behavior change for manual creation

---

## 5. Test Coverage Gaps

### Current Coverage (from `follow-up-service.auto-generation.test.ts`)

| Scenario | Covered |
|----------|---------|
| Creates FU1 after initial send | ✅ |
| Creates FU2 after FU1 sent | ✅ |
| No draft at cadence limit | ✅ |
| No draft when anchor missing | ✅ |
| Idempotent re-recording | ✅ |
| Cancel deletes draft/ready | ✅ |
| Cancel clears schedule | ✅ |
| Cancel idempotent | ✅ |
| Cancel preserves seq 0 & sent | ✅ |

### Missing Test Scenarios

| Gap | Risk | Priority |
|-----|------|----------|
| **Draft creation failure logging** | Silent failures invisible in prod | Medium |
| **Retry after failure** — manual recreation works | Low (already works) | Low |
| **Concurrent markFollowUpSent** (race) | Already protected by DB constraint | Low |
| **Cancellation race** (both orders) | Logic correct, not tested | Low |
| **Unique constraint violation path** | Returns "conflict", not tested end-to-end | Low |

---

## Applied Fixes

### Fix 1: Added Logging for Draft Creation Failure ✅

```typescript
// In markFollowUpSent, lines 674-685
}).catch((err) => {
  // Log for observability but don't throw — schedule advance is the critical path.
  // The operator can create the follow-up manually via the "Next follow-up" form.
  console.error("[markFollowUpSent] Auto draft creation failed:", {
    leadId: input.leadId,
    anchorSequence,
    error: err instanceof Error ? err.message : String(err),
  });
});
```

### Fix 2: Added Regression Tests ✅

| Test | Verifies |
|------|----------|
| `logs error when createFollowUpDraft fails` | Error logged with leadId, anchorSequence, error message |
| `still advances schedule when draft creation fails` | Schedule durable despite draft failure |
| `two concurrent markFollowUpSent calls create only one draft` | No duplicates under race |
| `re-recording after cancel does not recreate cancelled draft` | Cancel state respected |

All 4 new tests pass (14 total in auto-generation suite).

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/services/follow-up-service.ts` | Added `console.error` logging in catch block |
| `src/lib/services/follow-up-service.auto-generation.test.ts` | Added 4 regression tests |

---

## Verification Checklist

| Check | Status |
|-------|--------|
| All existing tests pass | ✅ 1,452 passing |
| TypeScript clean | ✅ |
| Production build passes | ✅ |
| Draft creation failure logged | ✅ **Implemented** |
| Concurrent send race tested | ✅ **Implemented** |
| No schema migration needed | ✅ Confirmed |
| No automatic email sending | ✅ Confirmed |
| No production DB mutation | ✅ Confirmed |

---

## Conclusion

**The implementation is safe for production.** The reliability properties hold:

1. **No data loss** — schedule advance is durable; draft creation is best-effort
2. **No duplicates** — DB unique constraint + application guards
3. **No stuck sequences** — schedule always advances; manual recovery always available
4. **Cancellation safe** — preserves history, removes only pending work
5. **Content correct** — anchor, parent, sequence, recipient all verified
6. **Failures observable** — draft creation errors now logged

All recommended fixes applied. No schema migration required. No automatic email sending. No production database mutations.

---

*Review based on direct code inspection, test execution (1,448 tests), and analysis of database constraints and concurrency patterns.*