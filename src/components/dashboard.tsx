import { loadFollowUpWorkspace, loadOutreachDraftRows } from "@/app/actions";
import { loadOutreachStats } from "@/app/stats-actions";
import { FOLLOW_UP_TIMEZONE } from "@/lib/followup/cadence";
import { FollowUpDetailPanel } from "@/components/follow-up-detail-panel";
import {
  IconBuilding,
  IconFileText,
  IconInbox,
  IconRefresh,
  IconSend,
} from "@/components/icons";

/**
 * The dashboard body.
 *
 * Extracted from `page.tsx` so the page can own the request (session, env,
 * `?followup=` token resolution) while this component owns the data it shows.
 * Every loader here already reports failures as results rather than throwing,
 * so a database error degrades to an honest empty stat instead of a 500.
 *
 * When `initialFollowUpId` is set — the Telegram notification deep link — the
 * Phase 4C follow-up detail opens above the stats, where Open in Gmail and
 * Mark as sent live. Nothing is written by opening it.
 *
 * The sent counters are resolved in {@link FOLLOW_UP_TIMEZONE} — the same
 * Europe/Prague calendar the follow-up cadence, the streaks surface and the
 * 19:00 reminder all use, so "sent today" means the same day to the card, to
 * the timer and to the Telegram message.
 */
export async function Dashboard({
  initialFollowUpId,
}: {
  initialFollowUpId?: string | null;
}) {
  const draftsResult = await loadOutreachDraftRows();
  const drafts = draftsResult.ok ? draftsResult.drafts : [];

  // Follow-ups never appear in the drafts list, so their pending count comes
  // from the follow-ups workspace itself: unsent rows (due or scheduled).
  const workspaceResult = await loadFollowUpWorkspace();
  const pendingFollowUps = workspaceResult.ok
    ? workspaceResult.followUps.filter((f) => f.attention !== 2).length
    : 0;

  // Confirmed sends, counted server-side under the same predicate Stats uses
  // (status 'sent' with a sent_at). A failed load degrades to zero rather
  // than throwing — the card states the calendar it counted in either way.
  const statsResult = await loadOutreachStats({ timeZone: FOLLOW_UP_TIMEZONE });
  const sentToday = statsResult.ok ? statsResult.stats.today : 0;
  const sentThisWeek = statsResult.ok ? statsResult.stats.week : 0;
  const sentAllTime = statsResult.ok ? statsResult.stats.totalSent : 0;

  const stats = {
    drafts: drafts.length,
    leads: new Set(drafts.map((d) => d.lead.id)).size,
    sent: sentAllTime,
    sentToday,
    sentThisWeek,
    pendingFollowups: pendingFollowUps,
  };

  const quickLinks = [
    { href: "/parser", label: "Paste Emails", description: "Parse and save new outreach emails", icon: IconInbox },
    { href: "/drafts", label: "Drafts", description: "View and manage saved drafts", icon: IconFileText },
    { href: "/outreach", label: "Outreach History", description: "Browse sent outreach history", icon: IconSend },
    { href: "/follow-ups", label: "Follow-ups", description: "Manage follow-up sequences", icon: IconRefresh },
  ];

  return (
    <div className="flex flex-col gap-6">
      {initialFollowUpId ? <FollowUpDetailPanel messageId={initialFollowUpId} /> : null}

      <header>
        <h1 className="heading-sticker text-xl text-midnight">Dashboard</h1>
        <p className="mt-1 text-sm text-midnight-soft">Overview of your outreach pipeline</p>
      </header>

      <section aria-labelledby="stats-heading" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Sent today" value={stats.sentToday} icon={<IconSend size={16} />} />
        <StatCard label="Sent this week" value={stats.sentThisWeek} icon={<IconSend size={16} />} />
        <StatCard label="Sent Messages" value={stats.sent} icon={<IconSend size={16} />} />
        <StatCard label="Saved Drafts" value={stats.drafts} icon={<IconFileText size={16} />} />
        <StatCard label="Leads" value={stats.leads} icon={<IconBuilding size={16} />} />
        <StatCard label="Pending Follow-ups" value={stats.pendingFollowups} icon={<IconRefresh size={16} />} />
      </section>
      <p className="-mt-3 text-xs text-midnight-soft">
        Sent today and Sent this week count messages recorded as sent, in the {FOLLOW_UP_TIMEZONE}{" "}
        calendar — the same day the 19:00 streak reminder watches. Send at least one today to keep the
        streak.
      </p>

      <section aria-labelledby="quick-links-heading">
        <h2 id="quick-links-heading" className="heading-sticker text-sm text-midnight-soft mb-3">
          Quick Links
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {quickLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="sticker px-4 py-3.5 flex flex-col gap-1.5 transition-colors hover:border-midnight-line-strong hover:bg-midnight-faint/60"
            >
              <div className="flex items-center gap-2 text-accent">
                <link.icon size={16} />
                <span className="text-[13px] font-semibold text-midnight">{link.label}</span>
              </div>
              <p className="text-xs leading-relaxed text-midnight-soft">{link.description}</p>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <article className="sticker px-4 py-3.5 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-midnight-soft">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums leading-none text-midnight">{value}</p>
      </div>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-accent-soft text-accent">
        {icon}
      </span>
    </article>
  );
}
