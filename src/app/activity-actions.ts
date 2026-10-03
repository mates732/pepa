"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import {
  ACTIVITY_DEFAULT_LIMIT,
  getOutreachActivityDetail,
  listOutreachActivity,
  type OutreachActivityDetail,
  type OutreachActivityItem,
} from "@/lib/services/outreach-activity-service";

/**
 * Server actions for Outreach Activity.
 *
 * Separate from `actions.ts` only because Activity is a self-contained read-only
 * surface; it follows the existing `followup-actions.ts` / `import-actions.ts`
 * layout rather than growing the shared module.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   1. **Read-only.** Neither action writes, and neither calls `revalidatePath` —
 *      there is nothing to invalidate. Activity is an audit surface, so it offers
 *      no mutation entry point at all: no mark-unsent, no delete, no edit. The
 *      Gmail action that Activity's detail may call is `openOutreachInGmail()` in
 *      `actions.ts`, which is itself inert.
 *
 *   2. **Server-authoritative.** The browser sends nothing but, for the detail,
 *      a message id. Ordering, filtering, sequence labels and every field of
 *      content are decided from the database, so the client cannot reorder the
 *      history to its advantage or render content PEPA does not hold.
 */

/** Postgres rejects a malformed uuid; catch it here so no driver detail leaks. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActionFailure {
  ok: false;
  error: string;
}

function failure(error: string): ActionFailure {
  return { ok: false, error };
}

export type OutreachActivityListResult =
  | {
      ok: true;
      activity: OutreachActivityItem[];
      /** The window size actually applied, so the UI can describe it honestly. */
      limit: number;
      /** True when the window is full and older sends exist beyond it. */
      truncated: boolean;
      error: null;
    }
  | ActionFailure;

export type OutreachActivityDetailResult =
  | { ok: true; detail: OutreachActivityDetail; error: null }
  | ActionFailure;

/**
 * Load the recent window of sent outreach.
 *
 * Ordering and the `status = 'sent'` filter are applied by the service, so the
 * workspace receives already-ordered rows and never issues its own query.
 * Opening Activity records nothing.
 */
export async function loadOutreachActivity(): Promise<OutreachActivityListResult> {
  await requireAuthenticatedUser();

  try {
    const result = await listOutreachActivity(ACTIVITY_DEFAULT_LIMIT);
    if (!result.ok || !result.data) {
      return failure(result.error ?? "Activity could not be loaded.");
    }

    return {
      ok: true,
      activity: result.data,
      limit: ACTIVITY_DEFAULT_LIMIT,
      // A full window means there may be older sends behind it. The UI says the
      // list is a recent window rather than implying it is the whole history.
      truncated: result.data.length >= ACTIVITY_DEFAULT_LIMIT,
      error: null,
    };
  } catch {
    return failure("Activity could not be loaded.");
  }
}

/**
 * Load one sent message for the activity detail view.
 *
 * The message id is the only input. Recipient, subject, body, sequence position
 * and both predecessors are resolved from the database, so a crafted id cannot
 * redirect the view onto content the caller did not already have access to, and
 * a message that was never sent is not reachable here at all.
 */
export async function loadOutreachActivityDetail(
  messageId: string,
): Promise<OutreachActivityDetailResult> {
  await requireAuthenticatedUser();

  if (!messageId || !UUID_PATTERN.test(messageId)) {
    return failure("That outreach could not be identified.");
  }

  try {
    const result = await getOutreachActivityDetail(messageId);
    if (!result.ok || !result.data) {
      return failure(result.error ?? "That outreach could not be loaded.");
    }
    return { ok: true, detail: result.data, error: null };
  } catch {
    return failure("That outreach could not be loaded.");
  }
}