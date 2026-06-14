import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Clean fintech SaaS palette: cool neutral grays + a single indigo accent.
        // Mirrors the sibling ai-invoice-parser repo so the two demos read as one
        // consistent product line.
        canvas: "#FAFAFA",
        surface: "#FFFFFF",
        line: "#E5E7EB",
        ink: "#0A0A0A",
        muted: "#6B7280",
        accent: {
          DEFAULT: "#4F46E5",
          fg: "#FFFFFF",
          soft: "#EEF2FF",
        },
        // Pipeline-stage colors. Each procure-to-pay stage gets a stable hue so
        // the queue (left pane) and the trace timeline (right pane) agree at a
        // glance — this color language is the whole point of the dashboard.
        stage: {
          intake: "#6B7280", // gray  — parsed, not yet matched
          matched: "#047857", // green — clean 2/3-way match, straight-through
          approval: "#B45309", // amber — variance caught, routed to a human
          reconciled: "#4F46E5", // indigo — posted to the (fake) ERP
          blocked: "#B91C1C", // red   — duplicate / hard-stopped
        },
        // Generic severity colors for trace steps and badges.
        warn: {
          DEFAULT: "#B45309",
          soft: "#FEF3C7",
          line: "#FCD34D",
        },
        danger: {
          DEFAULT: "#B91C1C",
          soft: "#FEE2E2",
          line: "#FCA5A5",
        },
        ok: {
          DEFAULT: "#047857",
          soft: "#D1FAE5",
          line: "#6EE7B7",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-geist-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "var(--font-geist-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
        lift: "0 4px 12px rgba(16, 24, 40, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
