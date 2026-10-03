import { formatDate } from "@/lib/format";

/**
 * Day grouping for Outreach Activity.
 *
 * Pure leaf module, like `gmail-compose.ts` and `followup/cadence.ts`: no I/O,
 * no Supabase, no clock of its own. Everything about *how activity is grouped*
 * lives here so the rule can be tested without rendering anything.
 *
 * TIMEZONE — read this before changing anything.
 *
 * The application has no explicit timezone convention. `lib/format.ts` formats
 * every timestamp with `Intl.DateTimeFormat` and no `timeZone` option, so dates
 * already render in the reader's browser-local zone, and `followup/cadence.ts`
 * stores absolute UTC instants (`toUtcIso`). Activity follows that existing
 * behaviour rather than introducing a second, competing one:
 *
 *   * storage — absolute UTC, unchanged;
 *   * grouping — the reader's local calendar day, the same zone the surrounding
 *     UI already prints times in.
 *
 * That is deliberate consistency, not a claim about Prague local time. It does
 * mean two operators in different zones would each see their own midnight
 * boundary, exactly as they already do everywhere else in PEPA. Fixing that
 * properly is a timezone decision for the whole app, not one for this feature.
 */

export interface ActivityDayGroup<T> {
  /** Local `YYYY-MM-DD`, or `undated` for rows with no usable `sent_at`. */
  key: string;
  label: string;
  items: T[];
}

/** Local calendar day of an instant, as `YYYY-MM-DD`. */
export function localDayKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "undated";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** "Today" / "Yesterday" relative to `now`, in local time. */
function relativeLabel(dayKey: string, now: Date): string | null {
  if (dayKey === localDayKey(now)) return "Today";

  // Calendar-day arithmetic, not 24h subtraction: taking 24 hours off 23:30
  // crosses two midnights at a daylight-saving boundary.
  const yesterday = new Date(now.getTime());
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey === localDayKey(yesterday)) return "Yesterday";

  return null;
}

/**
 * Split activity into day sections, newest day first.
 *
 * `sentAtOf` reads the authoritative send timestamp from each row — Activity
 * orders and groups by `sent_at`, never by `created_at`, `next_followup_at` or
 * `followup_count`.
 *
 * Input order is preserved *within* a day, so the caller keeps full control of
 * ordering and this function never re-sorts rows it does not own.
 *
 * A row whose `sent_at` is missing or unparseable is collected into a final
 * `Date not recorded` group instead of being dropped or dated to today. It was
 * genuinely recorded as sent, so hiding it would understate the history, while
 * guessing its day would invent one.
 */
export function groupActivityByDay<T>(
  items: T[],
  sentAtOf: (item: T) => string | null,
  now: Date = new Date(),
): ActivityDayGroup<T>[] {
  // Keyed by day. `sample` is the first instant seen in that day, kept so the
  // label can be formatted from a real Date — re-parsing "2026-09-30" as an ISO
  // string would resolve to UTC midnight and could shift the printed day by one
  // for readers west of Greenwich.
  const buckets = new Map<string, { sample: Date; items: T[] }>();

  for (const item of items) {
    const sentAt = sentAtOf(item);
    const instant = sentAt ? new Date(sentAt) : null;
    const key = instant && !Number.isNaN(instant.getTime()) ? localDayKey(instant) : "undated";

    const existing = buckets.get(key);
    if (existing) existing.items.push(item);
    else {
      buckets.set(key, {
        sample: instant && !Number.isNaN(instant.getTime()) ? instant : now,
        items: [item],
      });
    }
  }

  const dated: ActivityDayGroup<T>[] = [];
  for (const [key, bucket] of buckets) {
    if (key === "undated") continue;
    dated.push({
      key,
      label: relativeLabel(key, now) ?? formatDate(bucket.sample),
      items: bucket.items,
    });
  }

  // Newest day first. `key` is a zero-padded local date, so lexical order is
  // chronological order — no Date parsing needed for the sort itself.
  dated.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

  const undated = buckets.get("undated");
  if (undated && undated.items.length > 0) {
    dated.push({ key: "undated", label: "Date not recorded", items: undated.items });
  }

  return dated;
}