"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { logout } from "@/app/auth-actions";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/parser", label: "Paste Emails", icon: "📥" },
  { href: "/drafts", label: "Drafts", icon: "📄" },
  { href: "/outreach", label: "Outreach", icon: "📤" },
  { href: "/follow-ups", label: "Follow-ups", icon: "🔄" },
] as const;

/**
 * App shell: sidebar (desktop ≥1200px), compact top header + drawer
 * (mobile & tablet <1200px), nothing on /login (the gate stands alone).
 *
 * `lg` is redefined to 75rem/1200px in globals.css — tablet (768–1199px)
 * gets the compact header, never a desktop-sized sidebar.
 *
 * The desktop sidebar is a sticky, viewport-height left column that lives in
 * the root layout's row flow (see layout.tsx); it is NOT stacked above the
 * content, which is what used to push every page below the first viewport.
 */
export function Header() {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  // The login page is a standalone gate — no navigation, no sign-out.
  if (pathname === "/login") return null;

  const brand = (
    <div className="flex items-center gap-2 px-3 py-4 border-b border-midnight-line">
      <div className="tilt grid h-10 w-10 shrink-0 place-items-center rounded-[1rem] border-[2px] border-midnight bg-midnight text-base font-black text-cream">
        P
      </div>
      <span className="font-bold text-midnight">PEPA</span>
    </div>
  );

  return (
    <>
      {/*
        Sidebar / drawer — ONE element, two modes:
        - <1200px: hidden until ☰ opens it, then a fixed drawer over a
          dimmed page (backdrop below, drawer above the top bar so × works).
        - ≥1200px: static sticky column in the root layout's row flow.
          The lg: overrides also "heal" a drawer left open across a resize.
      */}
      <aside
        id="mobile-nav"
        className={
          navOpen
            ? "fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-y-auto border-r border-midnight-line bg-cream pl-[env(safe-area-inset-left)] lg:static lg:z-auto lg:h-dvh lg:w-56 lg:shrink-0 lg:pl-0 lg:sticky lg:top-0"
            : "hidden flex-col border-r border-midnight-line bg-cream lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-56 lg:shrink-0"
        }
      >
        <nav className="flex flex-col p-4 gap-2">
          {brand}
          <ul className="flex-1 flex flex-col gap-1" role="navigation" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex items-center gap-3 px-3 py-3 text-base font-medium text-midnight-soft hover:bg-midnight-faint hover:text-midnight rounded-[0.75rem] transition-colors touch-manipulation"
                  onClick={() => setNavOpen(false)}
                  style={{ minHeight: "44px" }}
                >
                  <span aria-hidden="true" className="text-lg">{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-midnight-line pt-4">
            {/*
              The old form POSTed to an /api/auth/ sign-out route, which does
              not exist (src/proxy.ts excludes /api and no such route is
              defined), so signing out 404'd and left the operator signed in.
              `logout` is the existing server action that clears the session
              cookie.
            */}
            <form action={logout}>
              <button
                type="submit"
                className="flex items-center gap-2 w-full px-3 py-3 text-sm font-medium text-midnight-soft hover:bg-midnight-faint hover:text-midnight rounded-[0.75rem] transition-colors touch-manipulation"
                style={{ minHeight: "44px" }}
              >
                <span aria-hidden="true">🚪</span>
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </aside>

      {/* Compact top bar: mobile AND tablet (<1200px). */}
      <header className="lg:hidden sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-midnight-line bg-cream py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <div className="flex items-center gap-2">
          <div className="tilt grid h-10 w-10 shrink-0 place-items-center rounded-[1rem] border-[2px] border-midnight bg-midnight text-base font-black text-cream">
            P
          </div>
          <span className="font-bold text-midnight">PEPA</span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setNavOpen(!navOpen)}
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
          aria-controls="mobile-nav"
          style={{ minHeight: "44px", minWidth: "44px" }}
        >
          {navOpen ? "×" : "☰"}
        </button>
      </header>

      {/* Backdrop: under the top bar (z-20) so × stays clickable, over the page. */}
      {navOpen && (
        <div
          className="fixed inset-0 bg-midnight/30 z-10 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
    </>
  );
}
