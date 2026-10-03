import type { DuplicateState } from "@/lib/types";

/**
 * Formatting helpers.
 *
 * All of these render in the reader's browser-local zone: `Intl.DateTimeFormat`
 * with no `timeZone` option. That is the application's existing convention —
 * stored values are absolute UTC instants (see `followup/cadence.ts`) and this is
 * where they become readable. Nothing here converts or assumes a fixed zone.
 */

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", DATE_TIME).format(date);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(date);
}

/**
 * Clock time only, for a column that sits under a day heading.
 *
 * Same zone and locale as every other formatter here, so a time shown inside a
 * day group always agrees with the full timestamp shown elsewhere.
 */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function daysAgo(value: string | null | undefined): number | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

export const DUPLICATE_LABEL: Record<DuplicateState, string> = {
  new: "NEW LEAD",
  existing: "EXISTING LEAD",
  contacted: "ALREADY CONTACTED",
};