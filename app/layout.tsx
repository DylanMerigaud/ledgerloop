import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "ledgerloop — multi-agent procure-to-pay",
  description:
    "A multi-agent finance-ops demo: cooperating agents run invoice intake → 2/3-way matching → approval routing → reconciliation, with the live agent execution trace streamed as it happens. Built with Mastra.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
