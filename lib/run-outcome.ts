import type { TraceEvent } from "@/lib/trace";
import type { Outcome } from "@/lib/display";

/**
 * Pure helpers that derive the coarse per-invoice state from the streamed trace.
 * Kept out of the React hook so they're unit-testable (and because the queue
 * pill's colour depends on getting these exactly right — see `lib/run-outcome.test.ts`).
 */

/** A recognized stage output carried on a trace event's `data`. */
type StageData = Record<string, unknown> | undefined;

function dataOf(e: TraceEvent): StageData {
  return e.data as StageData;
}

/** True if the trace paused at reconciliation awaiting a human decision. */
export function isAwaitingApproval(trace: TraceEvent[]): boolean {
  return trace.some((e) => dataOf(e)?.["outcome"] === "awaiting");
}

/**
 * Derive the coarse outcome from the trace so far. Order matters: the
 * reconciliation `outcome` (when present) is the most specific signal and wins
 * over the earlier tier/verdict hints.
 */
export function deriveOutcome(trace: TraceEvent[], finished: boolean): Outcome {
  let outcome: Outcome = finished ? "reconciled" : "running";
  for (const e of trace) {
    const data = dataOf(e);
    if (!data) continue;

    // Reconciliation outcome — the definitive resolution.
    if (data["outcome"] === "awaiting") return "needs-approval"; // paused for a human
    if (data["outcome"] === "rejected" || data["outcome"] === "blocked")
      return "blocked";
    if (data["outcome"] === "posted") return "reconciled";

    // Earlier hints (before reconciliation arrives).
    if (data["verdict"] === "duplicate" || data["tier"] === "blocked")
      return "blocked";
    if (data["tier"] === "manager" || data["tier"] === "director") {
      outcome = "needs-approval";
    }
  }
  return outcome;
}
