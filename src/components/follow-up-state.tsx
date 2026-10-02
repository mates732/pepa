import { MAX_FOLLOW_UPS } from "@/lib/followup/cadence";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OutreachHistoryRow } from "@/lib/types";

/**
 * Compact follow-up state for the history table. No new page, no analytics —
 * just enough to see which follow-up is scheduled and whether the operator has
 * already been pinged about it, so a second notification is never a surprise.
 *
 * Pure on purpose: no `Date.now()`, so rendering stays deterministic.
 */
export function FollowUpState({ row }: { row: OutreachHistoryRow }) {
  const attempt = row.followup_count + 1;

  if (row.followup_count >= MAX_FOLLOW_UPS) {
    return <span className="text-xs text-neutral-500">Follow-up #{MAX_FOLLOW_UPS} done</span>;
  }

  if (!row.next_followup_at) {
    return <span className="text-xs text-neutral-400">No follow-up scheduled</span>;
  }

  const notified =
    row.lastFollowupNotifiedNumber !== null &&
    row.lastFollowupNotifiedNumber >= attempt;

  return (
    <div className="text-xs leading-snug">
      <div className="whitespace-nowrap text-neutral-700">
        Follow-up #{attempt} · due {formatDate(row.next_followup_at)}
      </div>
      {notified && row.lastFollowupNotifiedAt ? (
        <div className="text-emerald-700">
          Telegram notified {formatDateTime(row.lastFollowupNotifiedAt)}
        </div>
      ) : (
        <div className="text-neutral-400">Telegram not notified</div>
      )}
    </div>
  );
}