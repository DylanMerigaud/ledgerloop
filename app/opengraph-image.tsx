import { ImageResponse } from "next/og";

/**
 * The social preview card (1200×630) shown when the demo link is shared in
 * Slack / email / X / LinkedIn. Rendered at build time by next/og (no external
 * service). Mirrors the in-app palette (near-white canvas + indigo accent) and the
 * "ll" loop mark so the unfurl reads as a deliberate product, not a bare title.
 */

export const runtime = "nodejs";
export const alt =
  "ledgerloop — an onboarding agent that reads a client's HRIS, derives their approval workflow, and runs procure-to-pay against it";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#101113";
const MUTED = "#6B6F76";
const ACCENT = "#5B53D6";
const LINE = "#E8E8EC";

export default function OpengraphImage() {
  const stages = ["Onboard", "Derive workflow", "Run pipeline", "Reconcile"];

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#FAFAFA",
        padding: "72px 80px",
        fontFamily: "sans-serif",
      }}
    >
      {/* Top: the "ll" loop mark + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 48,
            height: 48,
            borderRadius: 12,
            background: INK,
          }}
        >
          <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
            <path
              d="M12 7v12a4 4 0 0 0 4 4"
              stroke="#fff"
              strokeWidth="3.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M20 7v12a4 4 0 0 0 4 4"
              stroke={ACCENT}
              strokeWidth="3.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: INK,
            letterSpacing: -0.5,
          }}
        >
          ledgerloop
        </div>
      </div>

      {/* Middle: headline + subline */}
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <div
          style={{
            fontSize: 58,
            fontWeight: 700,
            color: INK,
            lineHeight: 1.08,
            letterSpacing: -1.5,
            maxWidth: 1000,
          }}
        >
          An onboarding agent that derives the approval workflow
        </div>
        <div
          style={{ fontSize: 27, color: MUTED, lineHeight: 1.4, maxWidth: 940 }}
        >
          It reads a client&apos;s HRIS, resolves who signs off on what to real
          people, and runs procure-to-pay against the workflow it builds. Live
          execution trace, with a human in the loop before anything posts.
        </div>
      </div>

      {/* Stage flow */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {stages.map((label, i) => (
          <div
            key={label}
            style={{ display: "flex", alignItems: "center", gap: 14 }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: "#FFFFFF",
                border: `1px solid ${LINE}`,
                borderRadius: 999,
                padding: "12px 22px",
                fontSize: 24,
                color: INK,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  background: "#EEF2FF",
                  color: ACCENT,
                  fontSize: 15,
                  fontWeight: 700,
                }}
              >
                {i + 1}
              </div>
              {label}
            </div>
            {i < stages.length - 1 && (
              <div style={{ fontSize: 26, color: LINE }}>→</div>
            )}
          </div>
        ))}
      </div>

      {/* Footer: stack + author */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 22,
          color: MUTED,
          borderTop: `1px solid ${LINE}`,
          paddingTop: 28,
        }}
      >
        <div>Mastra · Next.js · Claude Haiku · Supabase</div>
        <div style={{ color: INK }}>Dylan Mérigaud</div>
      </div>
    </div>,
    { ...size },
  );
}
