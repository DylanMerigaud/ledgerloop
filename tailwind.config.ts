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
        // Light product palette in the Attio register: white surfaces separated by
        // CRISP 1px borders (not soft shadows — that read "baveux"), an almost-white
        // page, and a neutral ramp. Primary actions are INK (black), so the accent
        // is demoted to a thin highlight (focus ring, selected state, small marks).
        canvas: "#FCFCFC", // page — effectively white, a hair off so cards read
        surface: "#FFFFFF",
        subtle: "#F7F7F8", // nested fills (chips, inputs, hover) — barely there
        line: "#E8E8EC", // default hairline — VISIBLE and crisp (the Attio look)
        "line-strong": "#DCDCE1", // dividers / input borders that must read
        ink: "#101113", // near-black, neutral (not blue-tinted)
        muted: "#6B6F76", // secondary text
        faint: "#9A9DA4", // tertiary text (timestamps, hints)
        accent: {
          DEFAULT: "#5B53D6", // a calmer indigo-violet, used only as a thin accent
          hover: "#4A43C0",
          fg: "#FFFFFF",
          soft: "#EFEEFB",
          ring: "#C9C5F0",
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
        // Attio register: surfaces are defined by BORDERS, not shadows. `card` is a
        // single hairline that barely lifts; `lift` is reserved for things that
        // truly float over content (popovers, the "N more" pill).
        card: "0 1px 2px rgba(16, 17, 19, 0.04)",
        lift: "0 8px 24px rgba(16, 17, 19, 0.12), 0 2px 6px rgba(16, 17, 19, 0.06)",
        // A subtle inset for the black primary button so it has a touch of depth.
        button: "0 1px 2px rgba(16, 17, 19, 0.18)",
      },
      borderRadius: {
        xl: "0.625rem",
        "2xl": "0.75rem",
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
