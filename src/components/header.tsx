"use client";

import { useState } from "react";
import Link from "next/link";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/parser", label: "Paste Emails", icon: "📥" },
  { href: "/drafts", label: "Drafts", icon: "📄" },
  { href: "/outreach", label: "Outreach", icon: "📤" },
  { href: "/follow-ups", label: "Follow-ups", icon: "🔄" },
] as const;

export function Header() {
  const [navOpen, setNavOpen] = useState(false);

  const toggleNav = () => setNavOpen(!navOpen);

  return (
    <>
      <aside className={`hidden lg:flex lg:flex-col lg:w-56 lg:border-r lg:border-midnight-line lg:bg-cream/50 lg:min-h-screen ${navOpen ? "fixed top-0 left-0 h-full z-50" : ""}`}>
        <nav className="flex flex-col p-4 gap-1">
          <div className="flex items-center gap-2 px-3 py-4 border-b border-midnight-line">
            <div className="tilt grid h-10 w-10 shrink-0 place-items-center rounded-[1rem] border-[2px] border-midnight bg-midnight text-base font-black text-cream">
              P
            </div>
            <span className="font-bold text-midnight">PEPA</span>
          </div>
          <ul className="flex-1 flex flex-col gap-1" role="navigation" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-midnight-soft hover:bg-midnight-faint hover:text-midnight rounded-[0.75rem] transition-colors"
                  onClick={() => setNavOpen(false)}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-midnight-line pt-4">
            <form action="/api/auth/signout" method="post">
              <button type="submit" className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-midnight-soft hover:bg-midnight-faint hover:text-midnight rounded-[0.75rem] transition-colors">
                <span aria-hidden="true">🚪</span>
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </aside>

      <header className="lg:hidden sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-midnight-line bg-cream px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="tilt grid h-10 w-10 shrink-0 place-items-center rounded-[1rem] border-[2px] border-midnight bg-midnight text-base font-black text-cream">
            P
          </div>
          <span className="font-bold text-midnight">PEPA</span>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => setNavOpen(!navOpen)}
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
        >
          ☰
        </button>
      </header>
    </>
  );
}