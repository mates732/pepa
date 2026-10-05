import type { BulkEmailRow, BulkEmailStatus, BulkEmailSummary } from "@/lib/import/bulk-plan";
import { formatDate } from "@/lib/format";

/**
 * Bulk preview — the table the operator checks before anything is written.
 *
 * Presentational and pure, so the states that matter can be asserted by
 * rendering them rather than by driving the dialog. Every email is shown,
 * including the ones that will NOT become drafts: an import that silently drops
 * one is indistinguishable from an import that created it.
 *
 * Two-column palette only, as everywhere else in the app — severity is read
 * from ink density, so `ready` is the lightest and a refusal is solid.
 */
const STATUS_TONE: Record<BulkEmailStatus, string> = {
  ready: "border-midnight bg-midnight-faint text-midnight",
  no_lead_match: "border-midnight-line bg-paper text-midnight-soft border-dashed",
  already_contacted: "border-midnight bg-midnight text-cream",
  duplicate: "border-midnight bg-midnight/35 text-midnight",
  needs_review: "border-midnight-line bg-paper text-midnight-soft border-dashed",
  failed: "border-midnight bg-midnight/65 text-cream",
};

const STATUS_LABEL: Record<BulkEmailStatus, string> = {
  ready: "Ready",
  no_lead_match: "No lead match",
  already_contacted: "Already contacted",
  duplicate: "Duplicate",
  needs_review: "Needs review",
  failed: "Failed",
};

/** How the block was read, for the caption under the summary. */
const SPLIT_BY_LABEL: Record<string, string> = {
  recipient_header: "split on To:/Adresát headers",
  separator: "split on --- separators",
  blank_line: "split on blank gaps",
  single: "read as one email",
};

export function BulkSummary({ summary, splitBy }: { summary: BulkEmailSummary; splitBy: string }) {
  const chips: Array<{ label: string; value: number; tone: string }> = [
    { label: "Ready", value: summary.ready, tone: "bg-midnight-faint text-midnight border-midnight" },
    {
      label: "Already contacted",
      value: summary.alreadyContacted,
      tone: "bg-midnight text-cream border-midnight",
    },
    {
      label: "No lead match",
      value: summary.noLeadMatch,
      tone: "bg-paper text-midnight-soft border-midnight-line border-dashed",
    },
    {
      label: "Needs review",
      value: summary.needsReview,
      tone: "bg-paper text-midnight-soft border-midnight-line border-dashed",
    },
    {
      label: "Duplicate",
      value: summary.duplicates,
      tone: "bg-midnight/25 text-midnight border-midnight",
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-black uppercase tracking-wide text-midnight">
        Detected: {summary.total} email{summary.total === 1 ? "" : "s"}
      </span>
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={`inline-flex items-center gap-1 rounded-full border-2 px-2.5 py-0.5 text-[11px] uppercase tracking-wider ${chip.tone} ${
            chip.value === 0 ? "opacity-50" : ""
          }`}
        >
          {chip.value} {chip.label}
        </span>
      ))}
      {summary.failed > 0 ? (
        <span className="inline-flex items-center gap-1 rounded-full border-2 border-midnight bg-midnight/65 px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-cream">
          {summary.failed} Failed
        </span>
      ) : null}
      {summary.truncated > 0 ? (
        <span className="text-[11px] font-semibold uppercase tracking-wider text-midnight-soft">
          ⚠ {summary.truncated} over the limit were not read
        </span>
      ) : null}
      {splitBy ? (
        <span className="text-[11px] text-midnight-soft">{SPLIT_BY_LABEL[splitBy] ?? splitBy}</span>
      ) : null}
    </div>
  );
}

/** First lines of the body, so the operator can tell two emails apart. */
function bodyPreview(body: string | null): string {
  if (!body) return "";
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
}

/** One preview row. */
function PreviewRow({ row }: { row: BulkEmailRow }) {
  return (
    <tr className={row.status === "ready" ? "" : "opacity-85"}>
      <td className="px-3 py-2 align-top font-mono text-xs break-all text-midnight">
        {row.recipient ?? <span className="italic text-midnight-soft">—</span>}
        {row.leadCompany ? (
          <span className="mt-0.5 block font-sans text-[11px] text-midnight-soft">{row.leadCompany}</span>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top text-xs text-midnight">
        {row.subject ?? <span className="italic text-midnight-soft">(no subject)</span>}
        {bodyPreview(row.body) ? (
          <span className="mt-0.5 block text-[11px] leading-snug text-midnight-soft">
            {bodyPreview(row.body)}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top">
        <span
          className={`inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-[11px] uppercase tracking-wider ${STATUS_TONE[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
        {row.reason ? (
          <span className="mt-1 block max-w-[22rem] text-[11px] leading-snug text-midnight-soft">
            {row.reason}
          </span>
        ) : null}
        {row.status === "already_contacted" && row.lastContactedAt ? (
          <span className="mt-1 block text-[11px] font-semibold text-cream/80">
            Last contacted {formatDate(row.lastContactedAt)}
          </span>
        ) : null}
        {row.warnings.length > 0 ? (
          <span className="mt-1 block max-w-[22rem] text-[11px] leading-snug text-midnight-soft">
            {row.warnings.join(" ")}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * The preview table.
 *
 * `aria-live="polite"` because this is what the operator reads immediately after
 * pasting: the count changing under them without being announced is exactly the
 * kind of thing a screen-reader user has to go hunting for.
 */
export function BulkPreviewTable({ rows }: { rows: BulkEmailRow[] }) {
  if (rows.length === 0) return null;

  return (
    <div aria-live="polite" className="mt-4 max-h-[26rem] overflow-auto rounded-[1.25rem] border-[3px] border-midnight">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="sticky top-0">
          <tr className="bg-midnight text-[11px] uppercase tracking-wider text-cream">
            <th scope="col" className="px-3 py-2">Recipient</th>
            <th scope="col" className="px-3 py-2">Subject</th>
            <th scope="col" className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <PreviewRow key={row.index} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}