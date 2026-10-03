"use server";

import { requireAuthenticatedUser } from "@/lib/auth/dal";
import { isValidTimeZone } from "@/lib/outreach/stats-windows";
import { getOutreachStreaks } from "@/lib/services/outreach-streak-service";

/**
 * Server action for Outreach Streaks.
 *
 * Reads and returns numbers. It performs no write, exposes no mutation verb,
 * and calls no `revalidatePath` — nothing is stored, so there is nothing to
 * invalidate.
 *
 * WHAT THE CLIENT MAY AND MAY NOT SAY
 *
 * The only input is `timeZone`: the reader's IANA calendar, the same zone Stats
 * already reads from the browser. It decides where each day starts, and
 * nothing else.
 *
 *   * the client cannot supply counts or active days — every figure is computed
 *     from the database on the server;
 *   * it cannot supply or shift the boundaries, nor say what "today" is: the
 *     server derives today, the week and the month from the zone and its own
 *     clock. `now` is injectable for tests but is never an action parameter;
 *   * it cannot set `complete` or `currentStreakComplete`. Those are computed
 *     from the row count against the scan cap, so a caller cannot claim the
 *     history is complete — or incomplete — to change what the UI says about
 *     it.
 *
 * A caller naming a different zone than it renders in can only file a real send
 * under an adjacent day. It cannot manufacture history.
 */

export interface ActionFailure {
  ok: false;
  error: string;
}

function failure(error: string): ActionFailure {
  return { ok: false, error };
}

export interface StreakValues {
  currentStreak: number;
  longestStreak: number;
  activeDaysThisWeek: number;
  activeDaysThisMonth: number;
  totalActiveDays: number;
  daysInWeek: number;
  daysInMonth: number;
}

export type LoadOutreachStreaksResult =
  | {
      ok: true;
      /** Counted server-side. No message rows ever cross this boundary. */
      streaks: StreakValues;
      /** False when the figures cover a capped scan rather than every stored send. */
      complete: boolean;
      /** False when even the current streak may be understated by that cap. */
      currentStreakComplete: boolean;
      /** The zone the days, week and month were resolved in, so the UI can state it. */
      timeZone: string;
      error: null;
    }
  | ActionFailure;

/**
 * Load the current streaks for the reader's calendar.
 *
 * Authenticated first: an unauthenticated request is rejected before any
 * Supabase access, so hiding the section in the UI is never the only defence.
 */
export async function loadOutreachStreaks(input: {
  timeZone: string;
}): Promise<LoadOutreachStreaksResult> {
  await requireAuthenticatedUser();

  if (!isValidTimeZone(input?.timeZone)) {
    return failure("Streaks could not be resolved for this time zone.");
  }

  try {
    const result = await getOutreachStreaks({ timeZone: input.timeZone });
    if (!result.ok || !result.data) {
      return failure(result.error ?? "Streaks could not be loaded.");
    }

    const data = result.data;

    // Only the seven figures and the two completeness flags cross the boundary.
    // Message rows and the window instants stay on the server.
    return {
      ok: true,
      streaks: {
        currentStreak: data.currentStreak,
        longestStreak: data.longestStreak,
        activeDaysThisWeek: data.activeDaysThisWeek,
        activeDaysThisMonth: data.activeDaysThisMonth,
        totalActiveDays: data.totalActiveDays,
        daysInWeek: data.daysInWeek,
        daysInMonth: data.daysInMonth,
      },
      complete: data.complete,
      currentStreakComplete: data.currentStreakComplete,
      timeZone: data.windows.timeZone,
      error: null,
    };
  } catch {
    return failure("Streaks could not be loaded.");
  }
}