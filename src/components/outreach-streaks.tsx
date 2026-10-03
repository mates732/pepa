"use client";

/**
 * Outreach Streaks — the card.
 *
 * Factual calendar metrics, counted on the server from `outreach_messages`.
 * Every figure arrives already measured; this component only formats it and
 * states the limits of what it is showing.
 *
 * What it deliberately does not do:
 *
 *   * no gamification of any kind — no XP, points, badges, levels, rewards,
 *     streak freezes or milestone copy. "🔥", "keep going" and "don't break the
 *     streak" would each be a claim this data cannot make, and each would turn
 *     an analytics surface into a game;
 *   * no controls. Nothing here writes, and there is nothing to act on: a send
 *     is recorded in the composer, and this card reports what was recorded;
 *   * no local arithmetic. A send recorded a moment ago is re-read from the
 *     server, never added to today's count here, because one send on a day that
 *     already has three is still one active day.
 *
 * HONESTY OVER NEATNESS
 *
 * Two different claims are on this card and they are not equally certain. The
 * current streak is a statement about a run that ends today. The longest streak
 * is a statement about all history, and under a capped scan that history is not
 * all there is. They are therefore labelled separately: a capped history is
 * stated next to the longest streak, while a current streak that is exact is
 * shown as exact.
 */

/** The figures, already measured by the server. */
export interface OutreachStreakValues {
  currentStreak: number;
  longestStreak: number;
  activeDaysThisWeek: number;
  activeDaysThisMonth: number;
  totalActiveDays: number;
  /** Length of the resolved week window, for the "n / m" denominator. */
  daysInWeek: number;
  /** Length of the resolved month window: 28, 29, 30 or 31. */
  daysInMonth: number;
}

const EMPTY: OutreachStreakValues = {
  currentStreak: 0,
  longestStreak: 0,
  activeDaysThisWeek: 0,
  activeDaysThisMonth: 0,
  totalActiveDays: 0,
  daysInWeek: 7,
  daysInMonth: 31,
};

/** Shown beside a historical figure that a capped scan cannot vouch for. */
const BASED_ON_AVAILABLE_HISTORY = "Based on available history";

interface OutreachStreaksProps {
  streaks: OutreachStreakValues | null;
  loading: boolean;
  error: string | null;
  /** False when the figures cover a capped scan rather than every stored send. */
  complete: boolean;
  /** False when the current streak itself may be understated by the cap. */
  currentStreakComplete: boolean;
  /** The IANA zone the days, week and month were resolved in. */
  timeZone: string | null;
}

/** One figure, with an optional qualifier line printed under the number. */
function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="min-w-0 rounded-[1rem] border-[3px] border-midnight-line bg-paper px-3 py-2">
      <p className="field-label mb-1 truncate">{label}</p>
      <p className="text-2xl font-black leading-none tabular-nums text-midnight">{value}</p>
      {note ? <p className="mt-1 text-[11px] font-semibold text-midnight-soft">{note}</p> : null}
    </div>
  );
}

/** `5 / 7`, with the denominator the server resolved for the calendar. */
function ratio(part: number, whole: number): string {
  return `${part.toLocaleString("en-GB")} / ${whole.toLocaleString("en-GB")}`;
}

export function OutreachStreaks({
  streaks,
  loading,
  error,
  complete,
  currentStreakComplete,
  timeZone,
}: OutreachStreaksProps) {
  // A real zero everywhere is the honest zero state; there is no placeholder
  // reading that could be mistaken for a measurement.
  const values: OutreachStreakValues = streaks ?? EMPTY;
  const noActiveDays = values.totalActiveDays === 0;

  const currentNote = complete || currentStreakComplete ? undefined : "May be understated";
  const longestNote = complete ? undefined : BASED_ON_AVAILABLE_HISTORY;

  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          <span className="chip chip-solid mr-2 align-middle">7</span>
          Outreach streaks
        </h2>
        <span className="chip">
          {loading
            ? "Loading…"
            : `${values.totalActiveDays.toLocaleString("en-GB")} active ${
                values.totalActiveDays === 1 ? "day" : "days"
              }`}
        </span>
      </header>

      {error ? (
        <p className="m-5 notice notice-alarm">{error}</p>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Figure
              label="Current streak"
              value={`${values.currentStreak.toLocaleString("en-GB")} ${
                values.currentStreak === 1 ? "day" : "days"
              }`}
              note={currentNote}
            />
            <Figure
              label="Longest streak"
              value={`${values.longestStreak.toLocaleString("en-GB")} ${
                values.longestStreak === 1 ? "day" : "days"
              }`}
              note={longestNote}
            />
            <Figure
              label="Active days this week"
              value={ratio(values.activeDaysThisWeek, values.daysInWeek)}
            />
            <Figure
              label="Active days this month"
              value={ratio(values.activeDaysThisMonth, values.daysInMonth)}
            />
          </div>

          <div className="space-y-1 border-t-[3px] border-dashed border-midnight-line pt-3">
            {noActiveDays ? (
              <p className="text-xs font-semibold text-midnight-soft">
                No active days yet. A day becomes active when outreach recorded as sent falls on it.
              </p>
            ) : null}
            {complete ? null : (
              <p className="text-xs font-semibold text-midnight-soft">
                History is capped at the most recent recorded sends. The longest streak is stated for
                the available history and may be longer in sends that were not loaded.
              </p>
            )}
            {currentStreakComplete ? null : (
              <p className="text-xs font-semibold text-midnight-soft">
                The current streak may also be understated, because the capped window may not reach
                back far enough to cover every day in the run ending today.
              </p>
            )}
            <p className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
              Consecutive calendar days with a recorded send
              {timeZone ? ` · days, weeks and months in ${timeZone}` : ""}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}