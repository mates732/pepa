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
      <body className="flex min-h-full flex-col text-midnight">
        <Header />
        <main className="flex-1 lg:mx-auto lg:max-w-6xl lg:w-full lg:px-6 lg:py-8 px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}