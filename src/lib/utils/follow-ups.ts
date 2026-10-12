/**
 * Follow-ups workspace presentation logic.
 *
 * Pure functions over the shape `listFollowUps()` returns — no I/O, no React —
 * so the rule that separates the actionable queue from everything else can be
 * tested directly rather than inferred from rendered markup.
 *
 * The invariant these encode, straight from the workflow spec:
 *
 *   * A follow-up is actionable only when the server marked it due
 *     (`attention === 0`): the initial was marked sent, the schedule computed
 *     from that send has arrived, and the row is still unsent.
 *   * Future follow-ups never enter the actionable queue. They sit in the
 *     schedule section with an honest state — scheduled, waiting for the
 *     initial send, or unscheduled.
 *   * Sent rows are history.
 */

/** The three sections of the workspace, in display order. */
export type FollowUpBucket = "due" | "scheduled" | "sent";

/** Why an unsent follow-up is (not) actionable, as a row-level chip. */
export type FollowUpScheduleState =
  | "due"
  | "scheduled"
  | "unscheduled"
  | "waiting-initial";

/**
 * Minimal slice of `FollowUpListItem` these helpers read. Structural, so the
 * client component's local props interface and the service type both satisfy it.
 */
export interface FollowUpBucketable {
  due: boolean;
  dueAt: string | null;
  attention: 0 | 1 | 2;
  initialSent: boolean;
  message: { status: string; sent_at: string | null };
}

function isSentRow(item: FollowUpBucketable): boolean {
  return item.message.sent_at !== null || item.message.status === "sent";
}

/**
 * Which section a follow-up belongs to.
 *
 * The server's `attention` rank is the authority for due/sent — it is computed
 * against the same clock the notification engine uses. Row state is only a
 * fallback for a sent row, so a stale rank can never push a sent follow-up back
 * into the actionable queue.
 */
export function followUpBucket(item: FollowUpBucketable): FollowUpBucket {
  if (isSentRow(item) || item.attention === 2) return "sent";
  if (item.attention === 0 || item.due) return "due";
  return "scheduled";
}

/**
 * The chip for an unsent follow-up — only meaningful when `followUpBucket`
 * returned `due` or `scheduled`; sent rows are history and carry their own
 * status instead.
 */
export function followUpScheduleState(item: FollowUpBucketable): FollowUpScheduleState {
  if (item.attention === 0 || item.due) return "due";
  if (item.dueAt) return "scheduled";
  // No clock running. A schedule only exists once the initial was marked sent
  // (only the send transition sets `next_followup_at`), so its absence while
  // the initial is still unsent means: inactive, waiting for that send.
  return item.initialSent ? "unscheduled" : "waiting-initial";
}

/** Partition a workspace page into its sections, preserving server order. */
export function groupFollowUps<T extends FollowUpBucketable>(
  items: readonly T[],
): Record<FollowUpBucket, T[]> {
  const grouped: Record<FollowUpBucket, T[]> = { due: [], scheduled: [], sent: [] };
  for (const item of items) grouped[followUpBucket(item)].push(item);
  return grouped;
}

/** Human label for the schedule chip. */
export function scheduleStateLabel(state: FollowUpScheduleState): string {
  switch (state) {
    case "due":
      return "Due";
    case "scheduled":
      return "Scheduled";
    case "unscheduled":
      return "Not scheduled";
    case "waiting-initial":
      return "Waiting for initial send";
  }
}
