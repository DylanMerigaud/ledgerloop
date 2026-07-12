import { outcomeExplain, outcomeLabel, outcomeTone, type Outcome } from "@/lib/display";

/**
 * The outcome banner across the top of the run pane: colour-coded to the result
 * (danger/blocked, warn/needs-approval, ok/reconciled) with a one-line why. Makes
 * the outcome obvious at the PANE level, not only as a badge on one graph node,
 * which is easy to miss on a blocked run where the graph looks otherwise normal.
 * Renders nothing for the transient states (idle / running / pending).
 */
const OUTCOME_BANNER_TONE: Record<
  "ok" | "warn" | "danger",
  { bar: string; dot: string; text: string }
> = {
  ok: { bar: "bg-ok-soft/60 ring-ok-line", dot: "#047857", text: "text-ok" },
  warn: {
    bar: "bg-warn-soft/60 ring-warn-line",
    dot: "#B45309",
    text: "text-warn",
  },
  danger: {
    bar: "bg-danger-soft/60 ring-danger-line",
    dot: "#B91C1C",
    text: "text-danger",
  },
};
export const OutcomeBanner = ({ outcome }: { outcome: Outcome }) => {
  const why = outcomeExplain(outcome);
  const tone = outcomeTone(outcome);
  // Only the three resolved outcomes get a banner (tone maps them to ok/warn/danger).
  if (tone !== "ok" && tone !== "warn" && tone !== "danger") return null;
  const c = OUTCOME_BANNER_TONE[tone];
  return (
    <div
      data-testid="outcome-banner"
      className={`pointer-events-none flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] ring-1 ring-inset ${c.bar}`}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: c.dot }}
      />
      <span className={`shrink-0 font-medium ${c.text}`}>{outcomeLabel(outcome)}</span>
      {why && <span className="text-ink/70">{why}</span>}
    </div>
  );
};
