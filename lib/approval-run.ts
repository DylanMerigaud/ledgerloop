import {
  executeWorkflow,
  type Decisions,
  type ExecutionState,
  type StepState,
} from "@/lib/approval-engine";
import {
  type ApprovalWorkflow,
  type InvoiceContext,
} from "@/lib/approval-workflow";
import type { MatchResult } from "@/lib/schema";

/**
 * The bridge between the conditional-workflow ENGINE and the per-invoice pipeline.
 *
 * The engine (lib/approval-engine.ts) is pure graph logic — it doesn't know about
 * invoices or matching. This module builds the engine's `InvoiceContext` from a
 * `MatchResult`, runs the workflow, and summarises the result into the things the
 * pipeline needs: the overall outcome, the currently-pending approval steps, and a
 * one-line narration. Keeping this here (not in the Mastra step) makes it unit-
 * testable without the workflow runtime.
 *
 * A duplicate is handled BEFORE the workflow — it's a control failure, not an
 * approval question — so callers check `match.verdict === "duplicate"` first and
 * never run the workflow for it.
 */
/** Build the engine's evaluation context from a match result. */
const contextFromMatch = (match: MatchResult): InvoiceContext => {
  return {
    amount: match.invoiceTotal,
    exceptionAmount: match.exceptionAmount,
    variancePct: match.maxVariancePct,
    department: match.department, // from the PO; "" = no dept → department gates skip
    verdict: match.verdict,
  };
};

export type ApprovalRun = {
  state: ExecutionState;
  /** "posted" once every active gate is approved; "awaiting" while gates pend; "rejected" on a no. */
  outcome: "posted" | "awaiting" | "rejected";
  /** Approval steps still waiting on a human (collect-all parallel gates). */
  pending: StepState[];
  /** One-line summary for the trace/narration. */
  narration: string;
};

/**
 * Run the approval workflow for a matched invoice and summarise it. Maps the
 * engine's `approved` (all gates cleared / none needed) to the pipeline's
 * "posted" intent — the reconciliation step does the actual ERP post when this is
 * "posted".
 */
export const runApproval = (
  workflow: ApprovalWorkflow,
  match: MatchResult,
  decisions: Decisions = {},
): ApprovalRun => {
  const state = executeWorkflow(workflow, contextFromMatch(match), decisions);
  const pending = state.steps.filter((s) => s.status === "pending");

  const outcome =
    state.outcome === "approved"
      ? "posted"
      : state.outcome === "rejected"
        ? "rejected"
        : "awaiting";

  const narration =
    outcome === "posted"
      ? approvedNarration(state)
      : outcome === "rejected"
        ? "An approver rejected the invoice — it will not be posted."
        : pendingNarration(pending);

  return { state, outcome, pending, narration };
};

const approvedNarration = (state: ExecutionState): string => {
  const gates = state.steps.filter((s) => s.status === "approved").length;
  if (gates === 0) {
    return "No approval gate applied — clean invoice cleared for straight-through posting.";
  }
  return `All ${gates} required approval${gates === 1 ? "" : "s"} granted — cleared to post.`;
};

const pendingNarration = (pending: StepState[]): string => {
  if (pending.length === 0) return "Awaiting approval.";
  const names = pending
    .map((p) => p.detail.replace(/^Awaiting /, ""))
    .join("; ");
  return pending.length === 1
    ? `Awaiting approval: ${names}`
    : `Awaiting ${pending.length} approvals in parallel: ${names}`;
};
