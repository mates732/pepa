"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { isValidTimeZone } from "@/lib/outreach/stats-windows";
import { getOutreachStats } from "@/lib/services/outreach-stats-service";

/**
 * Server action for Outreach Stats.
 *
 * Reads and returns numbers. It performs no write, exposes no mutation verb, and
 * calls no `revalidatePath` — there is nothing to invalidate, because nothing is
 * stored.
 *
 * WHAT THE CLIENT MAY AND MAY NOT SAY
 *
 * The only input is `timeZone`: the reader's IANA calendar, taken from
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`. It decides where each
 * window starts and nothing else.
 *
 *   * The client cannot supply counts — every number is computed from the
 *     database on the server.
 *   * The client cannot supply or shift the boundaries. It cannot pass "today" or
 *     a start instant; the server derives all six from the zone and the server's
 *     own clock. `now` is injectable for tests but is never an action parameter.
 *   * The client cannot inject sequence values, so the initial/follow-up split
 *     comes from stored `sequence_number` and nothing else.
 *
 * A caller naming a different zone than it renders in can only mis-file a real
 * send into an adjacent day. It cannot manufacture history.
 */

export interface ActionFailure {
  ok: false;
  error: string;
}

function failure(error: string): ActionFailure {
  return { ok: false, error };
}

export type LoadOutreachStatsResult =
  | {
      ok: true;
      /** Counted server-side. No message rows ever cross this boundary. */
      stats: {
        today: number;
        week: number;
        month: number;
        allTime: number;
        initialOutreach: number;
        followUps: number;
        totalSent: number;
      };
      /** False when the counts cover a capped scan rather than every row. */
      complete: boolean;
      /** The zone the windows were resolved in, so the UI can state it. */
      timeZone: string;
      error: null;
    }
  | ActionFailure;

/**
 * Load the current stats for the reader's calendar.
 *
 * Authenticated first: an unauthenticated request is rejected before any
 * Supabase access, so hiding the section in the UI is never the only defence.
 */
export async function loadOutreachStats(input: {
  timeZone: string;
}): Promise<LoadOutreachStatsResult> {
  await requireAuthenticatedUser();

  if (!isValidTimeZone(input?.timeZone)) {
    return failure("Stats could not be resolved for this time zone.");
  }

  try {
    const result = await getOutreachStats({ timeZone: input.timeZone });
    if (!result.ok || !result.data) {
      return failure(result.error ?? "Stats could not be loaded.");
    }

    const data = result.data;

    // Only the seven counts cross the boundary. Message rows stay on the server.
    return {
      ok: true,
      stats: {
        today: data.today,
        week: data.week,
        month: data.month,
        allTime: data.allTime,
        initialOutreach: data.initialOutreach,
        followUps: data.followUps,
        totalSent: data.totalSent,
      },
      complete: data.complete,
      timeZone: data.windows.timeZone,
      error: null,
    };
  } catch {
    return failure("Stats could not be loaded.");
  }
}