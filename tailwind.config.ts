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
        // Modern light product palette (Linear / Stripe register): a faintly cool
        // off-white page, pure-white surfaces that lift off it, a fuller neutral
        // ramp (so we stop hand-mixing ink/40, muted/70 everywhere), and one
        // confident indigo accent with a real hover + ring. Same accent family as
        // the sibling ai-invoice-parser repo so the demos read as one product line.
        canvas: "#FBFBFD", // page — a hair cool, lets white cards sit above it
        surface: "#FFFFFF",
        subtle: "#F5F6F8", // nested panels (chips, inputs) — depth without a border
        line: "#ECEDF1", // hairline borders — lighter than before, less "grid"
        "line-strong": "#DDDFE6", // dividers that need to read
        ink: "#0B0D12", // near-black with a faint cool cast
        muted: "#697586", // secondary text
        faint: "#98A1B0", // tertiary text (timestamps, hints) — replaces muted/70
        accent: {
          DEFAULT: "#4F46E5",
          hover: "#4338CA",
          fg: "#FFFFFF",
          soft: "#EEF2FF",
          ring: "#C7D2FE",
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
        // Soft, layered, low-opacity (Linear register) — visible depth, never harsh.
        card: "0 1px 2px rgba(11, 13, 18, 0.04), 0 2px 6px rgba(11, 13, 18, 0.05)",
        lift: "0 6px 16px rgba(11, 13, 18, 0.10), 0 2px 4px rgba(11, 13, 18, 0.06)",
        // A focused, pressable accent button gets a faint coloured cast.
        accent:
          "0 1px 2px rgba(79, 70, 229, 0.30), 0 6px 16px rgba(79, 70, 229, 0.18)",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 240ms ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
