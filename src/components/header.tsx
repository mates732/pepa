"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { logout } from "@/app/auth-actions";
import {
  IconDashboard,
  IconFileText,
  IconInbox,
  IconLogOut,
  IconRefresh,
  IconSend,
} from "@/components/icons";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: IconDashboard },
  { href: "/parser", label: "Paste Emails", icon: IconInbox },
  { href: "/drafts", label: "Drafts", icon: IconFileText },
  { href: "/outreach", label: "Outreach", icon: IconSend },
  { href: "/follow-ups", label: "Follow-ups", icon: IconRefresh },
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

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const brand = (
    <div className="flex items-center gap-2.5 px-3 py-4 border-b border-midnight-line">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-accent text-sm font-bold text-white">
        P
      </div>
      <span className="text-[15px] font-semibold tracking-tight text-midnight">
        PEPA
      </span>
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
            ? "fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-y-auto border-r border-midnight-line bg-shell pl-[env(safe-area-inset-left)] lg:static lg:z-auto lg:h-dvh lg:w-56 lg:shrink-0 lg:pl-0 lg:sticky lg:top-0"
            : "hidden flex-col border-r border-midnight-line bg-shell lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-56 lg:shrink-0"
        }
      >
        <nav className="flex flex-col p-3 gap-2">
          {brand}
          <ul
            className="flex-1 flex flex-col gap-0.5 pt-1"
            role="navigation"
            aria-label="Main navigation"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2.5 rounded-control px-3 py-2.5 text-sm transition-colors touch-manipulation ${
                      active
                        ? "bg-accent-soft font-semibold text-accent-strong"
                        : "font-medium text-midnight-soft hover:bg-midnight-faint hover:text-midnight"
                    }`}
                    onClick={() => setNavOpen(false)}
                    style={{ minHeight: "44px" }}
                  >
                    <Icon size={18} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-midnight-line pt-2 mt-2">
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
                className="flex w-full items-center gap-2.5 rounded-control px-3 py-2.5 text-sm font-medium text-midnight-soft transition-colors hover:bg-midnight-faint hover:text-midnight touch-manipulation"
                style={{ minHeight: "44px" }}
              >
                <IconLogOut size={18} />
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </aside>

      {/* Compact top bar: mobile AND tablet (<1200px). */}
      <header className="lg:hidden sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-midnight-line bg-shell py-2.5 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-accent text-sm font-bold text-white">
            P
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-midnight">
            PEPA
          </span>
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
          className="fixed inset-0 bg-midnight/25 z-10 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
    </>
  );
}
