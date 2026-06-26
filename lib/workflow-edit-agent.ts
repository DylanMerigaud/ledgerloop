import {
  type ApprovalWorkflow as TWorkflow,
  diffWorkflows,
  type StepChange,
} from "@/lib/approval-workflow";
import {
  applyEditOp,
  type WorkflowEditOp,
  type AvailableScope,
} from "@/lib/workflow-edit";
import {
  validateWorkflow,
  isActivatable,
  type WorkflowIssue,
} from "@/lib/workflow-validate";

/**
 * The conversational EDIT AGENT — the real agentic layer.
 *
 * Unlike a single structured-output call, this PLANS an ordered list of edit ops for
 * a (possibly multi-part) instruction, APPLIES them in order, then VALIDATES the
 * result with the validator (the tool). If the validator reports errors, it feeds
 * them back and asks for a correction, looping until the workflow is sound or a step
 * budget is hit. The user's "two parallel reviews, then a final sign-off that waits
 * on both" becomes several ops the agent sequences and checks — not one stateless
 * guess.
 *
 * Pure orchestration: the model is injected (so it's testable with a fake), and the
 * result is still a PROPOSAL — nothing is applied until the human approves the diff.
 *
 * Why this loop is hand-written (not a Mastra Agent): Mastra owns the parts that
 * need open-ended orchestration — the P2P pipeline (createWorkflow) and the
 * exception investigator (an Agent that freely chooses its tools). This edit loop is
 * the opposite: a BOUNDED, deterministic cycle where the validator MUST run after
 * every plan (a pure function we call, not a tool the model may skip), and the model
 * does strict structured output only. Keeping it as a plain loop over an injected
 * `PlanModel` guarantees that determinism and sidesteps Mastra's documented
 * structured-output-vs-tools exclusivity. "AI at the edge, deterministic core."
 */

/** Anything that can plan an ordered list of ops from an instruction + feedback. */
export type PlanModel = {
  /**
   * Plan the ops for `instruction` against `current`. `available` lists the real
   * departments so a department gate can only target one that exists (else the model
   * returns a `clarify` op). On a correction pass, `feedback` carries the validation
   * issues from the previous attempt (and the ops tried), so the model can fix them.
   */
  planOps: (args: {
    current: TWorkflow;
    instruction: string;
    available: AvailableScope;
    feedback?: { issues: WorkflowIssue[]; triedOps: WorkflowEditOp[] };
  }) => Promise<WorkflowEditOp[]>;
};

/** A question the agent asks back when an instruction is missing a piece it won't
    guess (e.g. which department) — the UI renders it as clickable options. */
type Clarification = { question: string; options: string[] };

export type AgentEditResult = {
  proposed: TWorkflow;
  ops: WorkflowEditOp[];
  changes: StepChange[];
  /** Issues remaining on the proposal (errors here mean the UI blocks Approve). */
  issues: WorkflowIssue[];
  /** If the agent produced no real change, why (for the UI's "no change" message). */
  reason: string | null;
  /** Set when the agent needs a missing piece before it can edit — the workflow is
      left UNCHANGED and the UI offers the options. null on a normal edit. */
  clarify: Clarification | null;
};

const MAX_STEPS = 4;

/** Apply an ordered op list to a workflow, returning the running result. */
const applyAll = (
  wf: TWorkflow,
  ops: WorkflowEditOp[],
): { result: TWorkflow; reason: string | null } => {
  let result = wf;
  let reason: string | null = null;
  for (const op of ops) {
    if (op.op === "none") {
      reason = op.reason; // remember the last decline reason
      continue;
    }
    result = applyEditOp(result, op);
  }
  return { result, reason };
};

/**
 * Run the agent: plan → apply (in order) → validate → correct → repeat. Returns the
 * net diff over the whole sequence and any remaining issues.
 */
export const runEditAgent = async (
  model: PlanModel,
  current: TWorkflow,
  instruction: string,
  available: AvailableScope,
): Promise<AgentEditResult> => {
  const allOps: WorkflowEditOp[] = [];
  let working = current;
  let reason: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const issues = validateWorkflow(working);
    const feedback = step === 0 ? undefined : { issues, triedOps: allOps };

    const ops = await model.planOps({
      current: working,
      instruction,
      available,
      feedback,
    });

    // The model is asking for a missing piece (e.g. which department). Surface the
    // question and stop — nothing is applied, the workflow is unchanged. (A clarify
    // is meant to be the only op, but if it's mixed in we still honour it first.)
    const clarifyOp = ops.find((o) => o.op === "clarify");
    if (clarifyOp) {
      return {
        proposed: current,
        ops: allOps,
        changes: [],
        issues: validateWorkflow(current),
        reason: null,
        clarify: {
          question: clarifyOp.question,
          options: clarifyOp.options,
        },
      };
    }

    const applied = applyAll(working, ops);
    working = applied.result;
    if (applied.reason) reason = applied.reason;
    allOps.push(...ops);

    // Done when the result is sound (no errors). Warnings are fine to return.
    if (isActivatable(validateWorkflow(working))) break;
    // If the model declined (all `none`) there's nothing more to try.
    if (ops.every((o) => o.op === "none")) break;
  }

  const changes = diffWorkflows(current, working);
  const realChanges = changes.filter((c) => c.kind !== "unchanged");
  return {
    proposed: working,
    ops: allOps,
    changes,
    issues: validateWorkflow(working),
    reason: realChanges.length === 0 ? (reason ?? "No change.") : null,
    clarify: null,
  };
};
