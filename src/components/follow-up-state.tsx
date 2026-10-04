import { MAX_FOLLOW_UPS } from "@/lib/followup/cadence";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OutreachHistoryRow } from "@/lib/types";

/**
 * Compact follow-up state for the history table. No new page, no analytics —
 * just enough to see which follow-up is scheduled and whether the operator has
 * already been pinged, so a second notification is never a surprise.
 *
 * Two numbers live in this cell and they are NOT the same number:
 *
 *   * `followup_count + 1` describes the SCHEDULE. `next_followup_at` was written
 *     for that follow-up number, so "Follow-up #3 · due 8 Oct" is a true
 *     statement about the schedule.
 *
 *   * `lastFollowupNotifiedNumber` describes the LEDGER. Since Phase 8A the
 *     ledger is keyed by `outreach_messages.sequence_number`, not by
 *     `followup_count + 1`, because the notified follow-up has to be a real
 *     message row. On a lead whose counter includes follow-ups that were never
 *     stored, those two numbers legitimately diverge.
 *
 * Comparing them — which this component used to do — produced a false "Telegram
 * not notified" on exactly those leads: the operator had just been notified about
 * stored follow-up #1 while the counter said #3. So the badge now reports what
 * the ledger says, verbatim, instead of asserting a comparison between two
 * different numbering systems.
 *
 * Pure on purpose: no `Date.now()`, so rendering stays deterministic.
 */
export function FollowUpState({ row }: { row: OutreachHistoryRow }) {
  const attempt = row.followup_count + 1;

  if (row.followup_count >= MAX_FOLLOW_UPS) {
    return <span className="text-xs text-midnight-soft">Follow-up #{MAX_FOLLOW_UPS} done</span>;
  }

  if (!row.next_followup_at) {
    return <span className="text-xs text-midnight-soft/70">No follow-up scheduled</span>;
  }

  return (
    <div className="text-xs leading-snug">
      <div className="whitespace-nowrap font-semibold text-midnight">
        Follow-up #{attempt} · due {formatDate(row.next_followup_at)}
      </div>
      {row.lastFollowupNotifiedNumber !== null && row.lastFollowupNotifiedAt ? (
        <div className="inline-flex items-center gap-1 rounded-full border-2 border-midnight bg-midnight px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cream">
          Notified · #{row.lastFollowupNotifiedNumber} ·{" "}
          {formatDateTime(row.lastFollowupNotifiedAt)}
        </div>
      ) : (
        <div className="text-midnight-soft/70">Telegram not notified</div>
      )}
    </div>
  );
}