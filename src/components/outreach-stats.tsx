"use client";

/**
 * Breakdown vocabulary.
 *
 * Defined here rather than imported from the service because that module is
 * `server-only`: a client component cannot pull a value out of it at runtime,
 * and pulling the label across would buy nothing — the classification itself
 * (`sequence_number` 0 vs > 0) already happened on the server.
 */
const INITIAL_OUTREACH_LABEL = "Initial outreach";
const FOLLOW_UPS_LABEL = "Follow-ups";

/**
 * Outreach Stats — the card.
 *
 * Purely factual counts of confirmed sends, derived on the server from
 * `outreach_messages`. Every figure arrives already counted; this component
 * only formats them.
 *
 * What it deliberately does not do:
 *
 *   * no streak, milestone or "achievement" framing — those are Phase 7+ and
 *     would turn a factual record into a game;
 *   * no control of any kind. No mark-as-sent, no edit, no Gmail hand-off. Stats
 *     is an analytical surface, and it has nothing to act on;
 *   * no sample or placeholder values. With nothing sent, every figure is a
 *     real 0.
 *
 * The zone the day/week/month windows were resolved in is printed rather than
 * implied, because "today" means something different to a reader in another
 * calendar and the number should be honest about which one it used.
 */

/** The seven figures, already counted by the server. */
interface OutreachStatsValues {
  today: number;
  week: number;
  month: number;
  allTime: number;
  initialOutreach: number;
  followUps: number;
  totalSent: number;
}

interface OutreachStatsProps {
  stats: OutreachStatsValues | null;
  loading: boolean;
  error: string | null;
  /** False when the counts cover a capped scan rather than every stored row. */
  complete: boolean;
  /** The IANA zone the windows were resolved in. */
  timeZone: string | null;
}

/** One figure. `label` renders uppercase via `.field-label`. */
function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-[1rem] border-[3px] border-midnight-line bg-paper px-3 py-2">
      <p className="field-label mb-1 truncate">{label}</p>
      <p className="text-2xl font-black leading-none tabular-nums text-midnight">
        {value.toLocaleString("en-GB")}
      </p>
    </div>
  );
}

export function OutreachStats({ stats, loading, error, complete, timeZone }: OutreachStatsProps) {
  // A real zero everywhere is the honest zero state; there is no "no data yet"
  // placeholder that could be mistaken for a missing reading.
  const values: OutreachStatsValues = stats ?? {
    today: 0,
    week: 0,
    month: 0,
    allTime: 0,
    initialOutreach: 0,
    followUps: 0,
    totalSent: 0,
  };

  const nothingSent = values.allTime === 0;

  return (
    <section className="sticker">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-midnight px-5 py-3">
        <h2 className="heading-sticker text-base text-midnight">
          <span className="chip chip-solid mr-2 align-middle">6</span>
          Outreach stats
        </h2>
        <span className="chip">{loading ? "Loading…" : `${values.totalSent.toLocaleString("en-GB")} sent`}</span>
      </header>

      {error ? (
        <p className="m-5 notice notice-alarm">{error}</p>
      ) : (
        <div className="space-y-4 p-4">
          {/* --- Periods ------------------------------------------------ */}
          <div>
            <h3 className="field-label mb-2">Recent</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Figure label="Today" value={values.today} />
              <Figure label="This week" value={values.week} />
              <Figure label="This month" value={values.month} />
              <Figure label="All time" value={values.allTime} />
            </div>
          </div>

          {/* --- Breakdown ---------------------------------------------- */}
          <div>
            <h3 className="field-label mb-2">Breakdown</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Figure label={INITIAL_OUTREACH_LABEL} value={values.initialOutreach} />
              <Figure label={FOLLOW_UPS_LABEL} value={values.followUps} />
              <Figure label="Total sent" value={values.totalSent} />
            </div>
          </div>

          {/* --- Provenance --------------------------------------------- */}
          <div className="space-y-1 border-t-[3px] border-dashed border-midnight-line pt-3">
            {nothingSent ? (
              <p className="text-xs font-semibold text-midnight-soft">
                No outreach recorded as sent yet. Drafts and unsent follow-ups are not counted.
              </p>
            ) : null}
            {complete ? null : (
              <p className="text-xs font-semibold text-midnight-soft">
                Counts cover the most recent stored sends only.
              </p>
            )}
            <p className="text-[11px] font-bold uppercase tracking-wider text-midnight-soft">
              Counted from outreach messages recorded as sent
              {timeZone ? ` · days and weeks in ${timeZone}` : ""}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}