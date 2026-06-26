import type { BadgeTone } from "@/components/ui/badge";
import type { TraceStatus, TraceStage } from "@/lib/trace";

/**
 * The shared visual vocabulary — the single place that maps pipeline concepts
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
 * How a SEEDED scenario should be signposted in the queue BEFORE it's run — so a
 * first-time visitor's eye goes straight to the interesting cases instead of a
 * flat list. Derived from the scenario label (already on every QueueItem), not a
 * new query. Three kinds, deliberately coarse:
 *   • "exception" — a flagged invoice (variance / control) that routes to a human
 *   • "blocked"   — a duplicate that's stopped before approval
 *   • "clean"     — a straight-through match (gets NO badge; only the noteworthy
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
 *  `clean` returns null — clean rows stay unmarked so the marks draw the eye. */
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
