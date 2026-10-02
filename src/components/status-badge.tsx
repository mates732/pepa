import type { LeadStatus } from "@/lib/types";

const STYLES: Record<LeadStatus, string> = {
  draft: "bg-slate-100 text-slate-700 ring-slate-300",
  ready: "bg-sky-50 text-sky-800 ring-sky-300",
  sent: "bg-emerald-50 text-emerald-800 ring-emerald-300",
  replied: "bg-violet-50 text-violet-800 ring-violet-300",
  follow_up: "bg-amber-50 text-amber-900 ring-amber-300",
  completed: "bg-neutral-200 text-neutral-700 ring-neutral-400",
  blocked: "bg-red-50 text-red-800 ring-red-300",
};

export function StatusBadge({ status }: { status: LeadStatus | null }) {
  if (!status) return <span className="text-neutral-400">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ring-1 ring-inset ${STYLES[status] ?? STYLES.draft}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}