import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const SITE_URL = "https://ledgerloop-eta.vercel.app";
const DESCRIPTION =
  "A multi-agent finance-ops demo: cooperating agents run invoice intake → 2/3-way matching → approval routing → reconciliation, with the live agent execution trace streamed as it happens and a real human-in-the-loop on caught mismatches. Built with Mastra.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "ledgerloop — multi-agent procure-to-pay",
  description: DESCRIPTION,
  // opengraph-image.tsx is picked up automatically; the blocks below complete
  // the unfurl (title / description / large-image card) for Slack, X, LinkedIn.
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "ledgerloop",
    title: "ledgerloop — multi-agent procure-to-pay",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "ledgerloop — multi-agent procure-to-pay",
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
