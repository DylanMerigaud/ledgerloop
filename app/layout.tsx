import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const SITE_URL = "https://ledgerloop-eta.vercel.app";
const TITLE = "ledgerloop — agentic procure-to-pay";
const DESCRIPTION =
  "A finance-ops demo: deterministic 2/3-way matching, approval routing, and reconciliation in code, with an AI agent that investigates flagged exceptions over messy vendor records — live execution trace streamed and a real human-in-the-loop before anything posts. Built with Mastra.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
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
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
