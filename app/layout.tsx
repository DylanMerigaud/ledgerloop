import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "@/app/globals.css";

import { QueryProvider } from "@/components/query-provider";

const SITE_URL = "https://ledgerloop-eta.vercel.app";
const TITLE = "ledgerloop · onboarding agent for procure-to-pay";
const DESCRIPTION =
  "An onboarding agent that reads a client's HRIS, derives their approval workflow (resolved to real people), and runs procure-to-pay against it. Deterministic matching and reconciliation in code, an AI agent that investigates flagged exceptions, a live execution trace, and a human in the loop before anything posts. Built with Mastra.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  // icon.svg is auto-detected for the favicon; declare the Apple touch icon
  // explicitly (Next doesn't auto-pick an SVG apple-icon) so iOS gets the mark.
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  // opengraph-image.tsx is picked up automatically; the blocks below complete
  // the unfurl (title / description / large-image card) for Slack, X, LinkedIn.
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "ledgerloop",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-full font-sans">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
