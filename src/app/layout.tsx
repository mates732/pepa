import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/header";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  description: "Internal outreach management: paste, parse, deduplicate, send.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      {/*
        Device-class layout contract:
        - <768px (mobile) and 768–1199px (tablet): column flow — compact top
          header (from <Header/>) with a collapsible drawer, content below.
        - >=1200px (desktop, `lg` redefined in globals.css): row flow — the
          <Header/> sidebar becomes a sticky left column and <main> starts at
          the top of the remaining space.

        The previous markup was `flex flex-col` at EVERY width: at lg the
        sidebar was a min-h-screen flex item stacked ABOVE <main>, which
        pushed all page content below the first viewport (the giant empty
        area above the dashboard). Making the container a row at lg is the
        structural fix — no per-page offsets involved.
      */}
      <body className="flex min-h-dvh flex-col text-midnight lg:flex-row">
        <Header />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-6 md:py-7 lg:mx-auto lg:w-full lg:max-w-6xl lg:px-8 lg:py-8">
          {children}
        </main>
      </body>
    </html>
  );
}