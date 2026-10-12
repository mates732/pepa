import type { LeadStatus } from "@/lib/types";

/**
 * Lifecycle from neutral → accent → success; exceptions carry semantic
 * warning/error tints. Every badge is a 1px hairline chip — no dark
 * outlines, no opacity ladder.
 */
const STYLES: Record<LeadStatus, string> = {
  draft: "bg-midnight-faint text-midnight-soft border-midnight-line-strong border-dashed",
  ready: "bg-accent-soft text-accent-strong border-accent/30",
  sent: "bg-success-soft text-success-ink border-success-line",
  replied: "bg-success-ink text-white border-success-ink font-semibold",
  follow_up: "bg-warning-soft text-warning-ink border-warning-line",
  completed: "bg-midnight text-white border-midnight",
  blocked: "bg-error-soft text-error-ink border-error-line",
};

export function StatusBadge({ status }: { status: LeadStatus | null }) {
  if (!status) {
    return (
      <span className="inline-flex rounded-full border border-dashed border-midnight-line-strong px-2 py-0.5 text-[11px] text-midnight-soft">
        —
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STYLES[status] ?? STYLES.draft}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
