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
    return <span className="text-xs text-midnight-soft">Follow-up #{MAX_FOLLOW_UPS} done</span>;
  }

  if (!row.next_followup_at) {
    return <span className="text-xs text-midnight-soft/70">No follow-up scheduled</span>;
  }

  const notified =
    row.lastFollowupNotifiedNumber !== null &&
    row.lastFollowupNotifiedNumber >= attempt;

  return (
    <div className="text-xs leading-snug">
      <div className="whitespace-nowrap font-semibold text-midnight">
        Follow-up #{attempt} · due {formatDate(row.next_followup_at)}
      </div>
      {notified && row.lastFollowupNotifiedAt ? (
        <div className="inline-flex items-center gap-1 rounded-full border-2 border-midnight bg-midnight px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cream">
          Telegram notified {formatDateTime(row.lastFollowupNotifiedAt)}
        </div>
      ) : (
        <div className="text-midnight-soft/70">Telegram not notified</div>
      )}
    </div>
  );
}