import { connection } from "next/server";
import { verifySession } from "@/lib/auth/dal";
import { getEnvStatus } from "@/lib/config/env";
import { loadOutreachDraftRows } from "@/app/actions";
import { SetupNotice } from "@/components/setup-notice";

export const metadata = {
  title: "PEPA · Outreach Tool",
};

export default async function DashboardPage() {
  await connection();
  await verifySession();

  const env = getEnvStatus();
  if (!env.configured) {
    return <SetupNotice missing={env.missing} detail={env.detail} />;
  }

  const draftsResult = await loadOutreachDraftRows();
  const drafts = draftsResult.ok ? draftsResult.drafts : [];

  const stats = {
    drafts: drafts.length,
    leads: new Set(drafts.map((d) => d.lead.id)).size,
    sent: 0,
    pendingFollowups: drafts.filter((d) => d.message.sequence_number > 0).length,
  };

  const quickLinks = [
    { href: "/parser", label: "Paste Emails", description: "Parse and save new outreach emails", icon: "📥" },
    { href: "/drafts", label: "Drafts", description: "View and manage saved drafts", icon: "📄" },
    { href: "/outreach", label: "Outreach History", description: "Browse sent outreach history", icon: "📤" },
    { href: "/follow-ups", label: "Follow-ups", description: "Manage follow-up sequences", icon: "🔄" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="heading-sticker text-2xl text-midnight">Dashboard</h1>
        <p className="mt-1 text-sm text-midnight-soft">Overview of your outreach pipeline</p>
      </header>

      <section aria-labelledby="stats-heading" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Saved Drafts" value={stats.drafts} icon="📄" />
        <StatCard label="Leads" value={stats.leads} icon="🏢" />
        <StatCard label="Sent Messages" value={stats.sent} icon="📤" />
        <StatCard label="Pending Follow-ups" value={stats.pendingFollowups} icon="🔄" />
      </section>

      <section aria-labelledby="quick-links-heading">
        <h2 id="quick-links-heading" className="heading-sticker text-lg text-midnight mb-4">
          Quick Links
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {quickLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="sticker p-4 flex flex-col gap-2 hover:bg-midnight-faint/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-2xl" aria-hidden="true">{link.icon}</span>
                <span className="font-semibold text-midnight">{link.label}</span>
              </div>
              <p className="text-sm text-midnight-soft">{link.description}</p>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <article className="sticker p-5 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium uppercase tracking-wider text-midnight-soft">{label}</span>
        <span className="text-2xl" aria-hidden="true">{icon}</span>
      </div>
      <p className="text-3xl font-black text-midnight">{value}</p>
    </article>
  );
}