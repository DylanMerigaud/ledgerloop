import type { BadgeTone } from "@/components/ui/badge";
import type { TraceStatus, TraceStage } from "@/lib/trace";

/**
 * The shared visual vocabulary, the single place that maps pipeline concepts
 * (a trace status, a stage, a final outcome) to a colour tone and a label. The
 * queue (left pane) and the trace timeline (right pane) both import from here so
 * they always agree: an "exception" is the same amber in both places. Keeping
 * this out of the components means the colour language is defined once.
 */

/** A coarse per-invoice outcome the queue shows as a status pill. */
export type Outcome =
  | "pending" // not run yet
  | "running" // pipeline in flight
  | "reconciled" // posted (clean or approved)
  | "needs-approval" // routed to a human
  | "blocked"; // duplicate / not posted

export const outcomeTone = (outcome: Outcome): BadgeTone => {
  switch (outcome) {
    case "reconciled":
      return "ok";
    case "needs-approval":
      return "warn";
    case "blocked":
      return "danger";
    case "running":
      return "accent";
    case "pending":
      return "neutral";
  }
};

export const outcomeLabel = (outcome: Outcome): string => {
  switch (outcome) {
    case "reconciled":
      return "Reconciled";
    case "needs-approval":
      return "Needs approval";
    case "blocked":
      return "Blocked";
    case "running":
      return "Running…";
    case "pending":
      return "Not run";
  }
};

/** A one-line "why" for a resolved outcome, for the pane's outcome banner. Null for
    the transient/idle states (nothing worth explaining yet). */
export const outcomeExplain = (outcome: Outcome): string | null => {
  switch (outcome) {
    case "reconciled":
      return "Cleared the 3-way match and posted to NetSuite.";
    case "needs-approval":
      return "An exception routed this to a human before it can post.";
    case "blocked":
      return "A control failed (duplicate); not posted, held for AP review.";
    case "running":
    case "pending":
      return null;
  }
};

/** Hex dot color per outcome (for the queue's leading status dot). */
export const outcomeDot = (outcome: Outcome): string => {
  switch (outcome) {
    case "reconciled":
      return "#047857";
    case "needs-approval":
      return "#B45309";
    case "blocked":
      return "#B91C1C";
    case "running":
      return "#4F46E5";
    case "pending":
      return "#D1D5DB";
  }
};

/**
 * How a SEEDED scenario should be signposted in the queue BEFORE it's run, so a
 * first-time visitor's eye goes straight to the interesting cases instead of a
 * flat list. Derived from the scenario label (already on every QueueItem), not a
 * new query. Three kinds, deliberately coarse:
 *   • "exception", a flagged invoice (variance / control) that routes to a human
 *   • "blocked"  , a duplicate that's stopped before approval
 *   • "clean"    , a straight-through match (gets NO badge; only the noteworthy
 *                   rows are marked, so the marks mean something)
 */
export type ScenarioKind = "exception" | "blocked" | "clean";

export const scenarioKind = (scenario: string | null): ScenarioKind => {
  const s = (scenario ?? "").toLowerCase();
  if (s.includes("duplicate") || s.includes("already paid")) return "blocked";
  if (
    s.includes("mismatch") ||
    s.includes("error") ||
    s.includes("not on po") ||
    s.includes("inactive")
  ) {
    return "exception";
  }
  return "clean";
};

/** The badge tone + short label for a signposted scenario kind (queue, pre-run).
 *  `clean` returns null, clean rows stay unmarked so the marks draw the eye. */
export const scenarioBadge = (
  kind: ScenarioKind,
): { tone: BadgeTone; label: string } | null => {
  switch (kind) {
    case "exception":
      return { tone: "warn", label: "exception" };
    case "blocked":
      return { tone: "danger", label: "blocked" };
    case "clean":
      return null;
  }
};

/**
 * A one-line plain-English WHY for a flagged scenario, for the queue hover. The
 * seeded `scenario` field is a terse label ("Duplicate invoice"); this turns it into
 * the reason an AP reviewer actually wants. Null for a clean row (nothing to explain).
 */
export const scenarioExplain = (scenario: string | null): string | null => {
  const s = (scenario ?? "").toLowerCase();
  if (s.includes("already paid"))
    return "A bill with this number is already posted in the ERP.";
  if (s.includes("duplicate"))
    return "This invoice number was already submitted in the queue.";
  if (s.includes("price mismatch"))
    return "Invoiced unit price is over the PO price.";
  if (s.includes("quantity mismatch"))
    return "Invoiced quantity exceeds what was received.";
  if (s.includes("arithmetic") || s.includes("error"))
    return "A line's amount doesn't equal unit price times quantity.";
  if (s.includes("not on po"))
    return "A billed line isn't on the purchase order.";
  if (s.includes("inactive")) return "The ERP marks this vendor inactive.";
  return null;
};

/** Map a trace step's status to a badge tone (for the timeline). */
export const statusTone = (status: TraceStatus): BadgeTone => {
  switch (status) {
    case "ok":
      return "ok";
    case "warn":
      return "warn";
    case "error":
      return "danger";
    case "running":
      return "accent";
    case "waiting":
      return "warn";
    case "skipped":
      return "neutral";
  }
};

/** Hex color for a trace step's connector dot. */
export const statusDot = (status: TraceStatus): string => {
  switch (status) {
    case "ok":
      return "#047857";
    case "warn":
      return "#B45309";
    case "error":
      return "#B91C1C";
    case "running":
      return "#4F46E5";
    case "waiting":
      return "#B45309";
    case "skipped":
      return "#D1D5DB";
  }
};

/** Human label for a pipeline stage. */
export const stageLabel = (stage: TraceStage): string => {
  switch (stage) {
    case "intake":
      return "Intake";
    case "matching":
      return "Matching";
    case "investigation":
      return "Investigation";
    case "approval":
      return "Approval";
    case "reconciliation":
      return "Reconciliation";
    case "pipeline":
      return "Pipeline";
  }
};
