import type { LeadStatus } from "@/lib/types";

/**
 * Two-colour palette only: every status is a midnight blue at a different
 * strength, so severity is read from density rather than from hue.
 * draft → blocked goes lightest to solid.
 */
const STYLES: Record<LeadStatus, string> = {
  draft: "bg-paper text-midnight-soft border-midnight-line border-dashed",
  ready: "bg-midnight-faint text-midnight border-midnight",
  sent: "bg-midnight/20 text-midnight border-midnight",
  replied: "bg-midnight/40 text-midnight border-midnight font-black",
  follow_up: "bg-midnight/65 text-cream border-midnight",
  completed: "bg-midnight/85 text-cream border-midnight",
  blocked: "bg-midnight text-cream border-midnight",
};

export function StatusBadge({ status }: { status: LeadStatus | null }) {
  if (!status) {
    return (
      <span className="inline-flex rounded-full border-2 border-dashed border-midnight-line px-2 py-0.5 text-[11px] text-midnight-soft">
        —
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-[11px] uppercase tracking-wider ${STYLES[status] ?? STYLES.draft}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
