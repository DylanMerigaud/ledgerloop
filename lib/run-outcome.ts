import type { WorkflowStep } from "@/lib/approval-workflow";
import { isRecord } from "@/lib/assert";
import type { Outcome } from "@/lib/display";
import type { TraceEvent } from "@/lib/trace";

/**
 * Pure helpers that derive the coarse per-invoice state from the streamed trace.
 * Kept out of the React hook so they're unit-testable (and because the queue
 * pill's colour depends on getting these exactly right — see `lib/run-outcome.test.ts`).
 */

/** A recognized stage output carried on a trace event's `data`. */
type StageData = Record<string, unknown> | undefined;

const dataOf = (e: TraceEvent): StageData => {
  return isRecord(e.data) ? e.data : undefined;
};

/** True if the trace paused awaiting a human decision (a gate or recon awaiting). */
export const isAwaitingApproval = (trace: TraceEvent[]): boolean => {
  return trace.some((e) => dataOf(e)?.["outcome"] === "awaiting");
};

/**
 * Build the per-step decisions map for a resume: apply the reviewer's single
 * decision to every gate currently PENDING in the trace (the collect-all set). The
 * approval step carries its steps on `data.steps`; we pick the pending ones.
 */
export const decisionsForPending = (
  trace: TraceEvent[],
  decision: "approve" | "reject",
): Record<string, "approve" | "reject"> => {
  const out: Record<string, "approve" | "reject"> = {};
  for (const e of trace) {
    const steps = dataOf(e)?.["steps"];
    if (!Array.isArray(steps)) continue;
    for (const raw of steps) {
      // Guard the shape instead of asserting it (raw is unknown from the trace).
      if (
        isRecord(raw) &&
        raw["status"] === "pending" &&
        typeof raw["id"] === "string"
      ) {
        out[raw["id"]] = decision;
      }
    }
  }
  return out;
};

/** One gate the run is currently waiting on — the fields the node needs to render
    its inline approve/reject. */
export type PendingGate = {
  id: string;
  label: string;
  approverName: string | null;
  approverTitle: string;
};

/**
 * The approval gates waiting on a human right now: the workflow's approval steps
 * whose live status is "pending", in workflow order. The Dashboard joins the run's
 * per-step statuses (`graphStatuses`) with the workflow's steps so each pending node
 * can show who it's waiting on and offer a per-gate decision. Integration steps and
 * already-settled gates (approved/rejected/skipped/blocked) are excluded.
 */
export const pendingGates = (
  statuses: Record<string, string>,
  steps: WorkflowStep[],
): PendingGate[] =>
  steps
    .filter((s) => s.kind === "approval" && statuses[s.id] === "pending")
    .map((s) => ({
      id: s.id,
      label: s.label,
      // Only approval steps reach here (filtered above); read the gate's people.
      approverName: s.kind === "approval" ? s.approverName : null,
      approverTitle: s.kind === "approval" ? s.approverTitle : "",
    }));

/**
 * Derive the coarse outcome from the trace so far. Order matters: the
 * reconciliation/approval `outcome` (when present) is the most specific signal and
 * wins over the earlier verdict hints.
 */
export const deriveOutcome = (
  trace: TraceEvent[],
  finished: boolean,
): Outcome => {
  const outcome: Outcome = finished ? "reconciled" : "running";
  for (const e of trace) {
    const data = dataOf(e);
    if (!data) continue;

    // Approval / reconciliation outcome — the definitive resolution.
    if (data["outcome"] === "awaiting") return "needs-approval"; // paused for a human
    if (data["outcome"] === "rejected" || data["outcome"] === "blocked")
      return "blocked";
    if (data["outcome"] === "posted") return "reconciled";

    // Earlier hint (before the approval/recon outcome arrives).
    if (data["verdict"] === "duplicate") return "blocked";
  }
  return outcome;
};
