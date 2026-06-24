import {
  evaluateCondition,
  describeCondition,
  type ApprovalWorkflow,
  type WorkflowStep,
  type InvoiceContext,
} from "./approval-workflow";
import { nonNull } from "./assert";

/**
 * Approval workflow engine — walk the DAG for one invoice and compute the state
 * of every step. Pure and deterministic: (workflow, invoice context, the human
 * decisions so far) → an execution snapshot. No side effects here; actually
 * posting to NetSuite / firing a Slack message is the caller's job (the workflow
 * step), driven off this snapshot. That keeps the routing logic exhaustively
 * unit-testable and the I/O at the edge.
 *
 * Execution model — parallel fan-out with collect-all human gates:
 *   • A step is REACHED when all its incoming edges come from steps that have
 *     completed (approved / skipped / done). Roots are reached immediately.
 *   • A reached step whose `when` condition is false is SKIPPED (and so are the
 *     branches that only it feeds, unless another active step also feeds them).
 *   • A reached approval step with a true condition is PENDING until the human
 *     decides it; the engine surfaces ALL currently-pending approvals at once
 *     (the parallel "In progress" steps you see fanned out), and the run waits
 *     until every one is resolved before the steps after them run.
 *   • One rejection blocks everything downstream (and the final post never runs).
 *   • A reached integration step with a true condition runs (status `done`)
 *     once it's unblocked.
 */

/** The lifecycle state of a single step for a given invoice + decision set. */
type StepStatus =
  | "pending" // approval step waiting on a human (the parallel "In progress" nodes)
  | "approved" // approval step a human approved
  | "rejected" // approval step a human rejected — blocks downstream
  | "skipped" // condition was false (or upstream didn't activate it)
  | "done" // integration step that ran
  | "blocked"; // couldn't run because an upstream step was rejected

export interface StepState {
  id: string;
  status: StepStatus;
  /** Human-readable reason, for the trace/UI. */
  detail: string;
}

/** The human's decision on a given approval step id. */
type StepDecision = "approve" | "reject";
export type Decisions = Record<string, StepDecision>;

export interface ExecutionState {
  steps: StepState[];
  /** Approval step ids currently waiting on a human (collect-all). */
  pending: string[];
  /** Overall: are we waiting, finished clean, or blocked by a rejection. */
  outcome: "awaiting" | "approved" | "rejected";
}

/**
 * Compute the execution snapshot. Walks the DAG in topological waves: a step is
 * only evaluated once all its predecessors have settled, so a pending approval
 * holds back everything behind it (the run pauses), while parallel siblings are
 * all surfaced together.
 */
export function executeWorkflow(
  workflow: ApprovalWorkflow,
  ctx: InvoiceContext,
  decisions: Decisions = {},
): ExecutionState {
  const byId = new Map<string, WorkflowStep>(
    workflow.steps.map((s) => [s.id, s]),
  );
  // Reverse edges: who feeds into each step (its predecessors).
  const predecessors = new Map<string, string[]>();
  for (const s of workflow.steps) predecessors.set(s.id, []);
  for (const s of workflow.steps) {
    for (const n of s.next) predecessors.get(n)?.push(s.id);
  }

  const state = new Map<string, StepState>();

  // Resolve a single step's state given its predecessors are already resolved.
  //
  // Join semantics (AND-join, which is what the fan-out-then-rejoin template
  // means): a step waits for ALL its predecessor PATHS to settle. A predecessor
  // is "settled-passed" when it's approved/done/skipped — a skipped gate is a
  // transparent pass-through (the gate didn't apply), NOT a dead branch, so flow
  // continues past it. A predecessor that is pending/blocked means not-yet; a
  // rejected predecessor hard-stops everything behind it.
  function resolve(step: WorkflowStep): StepState {
    const preds = predecessors.get(step.id) ?? [];
    // Predecessors are resolved before this step (topo order), so each is present.
    const predStates = preds.map((p) =>
      nonNull(state.get(p), `predecessor ${p} resolved before ${step.id}`),
    );

    const anyPredRejected = predStates.some((p) => p.status === "rejected");
    const anyPredWaiting = predStates.some(
      (p) => p.status === "pending" || p.status === "blocked",
    );

    // A rejection anywhere upstream blocks this step (the bill won't post).
    if (anyPredRejected) {
      return {
        id: step.id,
        status: "blocked",
        detail: "Blocked — an upstream approval was rejected.",
      };
    }
    // Any predecessor still pending/blocked → not reached yet; recompute after the
    // human acts. (For the AND-join, ALL paths must settle before we proceed.)
    if (anyPredWaiting) {
      return {
        id: step.id,
        status: "blocked",
        detail: "Waiting on an earlier approval before this step can run.",
      };
    }

    // All predecessors settled-and-passed (approved/done/skipped). Roots have none
    // and are always reached. Now the step's own condition decides skip vs run.
    const condText = describeCondition(step.when);
    if (!evaluateCondition(step.when, ctx)) {
      return {
        id: step.id,
        status: "skipped",
        detail: `Skipped — condition not met (${condText}).`,
      };
    }

    if (step.kind === "integration") {
      return {
        id: step.id,
        status: "done",
        detail: `Ran ${step.integration}.`,
      };
    }

    // Approval step, condition true → look at the human decision.
    const decision = decisions[step.id];
    if (decision === "approve") {
      return {
        id: step.id,
        status: "approved",
        detail: `Approved by ${step.approverName ?? step.approverTitle}.`,
      };
    }
    if (decision === "reject") {
      return {
        id: step.id,
        status: "rejected",
        detail: `Rejected by ${step.approverName ?? step.approverTitle}.`,
      };
    }
    return {
      id: step.id,
      status: "pending",
      detail: `Awaiting ${step.approverName ?? step.approverTitle}${
        condText === "always" ? "" : ` (${condText})`
      }.`,
    };
  }

  // Topological order (the DAG is small; Kahn's algorithm). Then resolve in order
  // so every step sees settled predecessors.
  for (const id of topoOrder(workflow)) {
    const step = byId.get(id);
    if (step) state.set(id, resolve(step));
  }

  // Every step was resolved in the loop above, so each has a state.
  const steps = workflow.steps.map((s) =>
    nonNull(state.get(s.id), `step ${s.id} was resolved`),
  );
  const pending = steps.filter((s) => s.status === "pending").map((s) => s.id);
  const rejected = steps.some((s) => s.status === "rejected");

  const outcome: ExecutionState["outcome"] = rejected
    ? "rejected"
    : pending.length > 0
      ? "awaiting"
      : "approved";

  return { steps, pending, outcome };
}

/** Kahn topological sort over the step graph. Assumes a DAG (the model is one). */
function topoOrder(workflow: ApprovalWorkflow): string[] {
  const indegree = new Map<string, number>();
  for (const s of workflow.steps) indegree.set(s.id, 0);
  for (const s of workflow.steps) {
    for (const n of s.next) indegree.set(n, (indegree.get(n) ?? 0) + 1);
  }
  const queue = [...indegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  const order: string[] = [];
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    order.push(id);
    for (const n of byId.get(id)?.next ?? []) {
      const d = (indegree.get(n) ?? 0) - 1;
      indegree.set(n, d);
      if (d === 0) queue.push(n);
    }
  }
  // Any nodes not emitted (shouldn't happen in a DAG) are appended so they still resolve.
  for (const s of workflow.steps) if (!order.includes(s.id)) order.push(s.id);
  return order;
}
