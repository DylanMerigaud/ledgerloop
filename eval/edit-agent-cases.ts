import { EDIT_FIXTURE } from "@/eval/edit-cases";
import type { WorkflowEditOp } from "@/lib/workflow-edit";

/**
 * Corpus for the EDIT-AGENT eval. Unlike the single-op edit eval (which scores the
 * chosen op kind), this scores the OUTCOME of the multi-instruction agent: after it
 * plans + applies + self-corrects, does the final workflow VALIDATE CLEAN, and did
 * it dispatch the expected number of ops for a multi-part instruction.
 */

export { EDIT_FIXTURE };

export type AgentCase = {
  id: string;
  instruction: string;
  /** Minimum real (non-none) ops we expect for this instruction. */
  minOps: number;
  why: string;
  /** Dry-run stub: the op list a correct plan would return (exercises the loop). */
  stub: WorkflowEditOp[];
};

export const AGENT_CASES: AgentCase[] = [
  {
    id: "single-add",
    instruction: "Above $50,000, also require CFO approval",
    minOps: 1,
    why: "one gate added; result still sound",
    stub: [
      {
        op: "add-approval",
        label: "CFO review",
        approverTitle: "CFO",
        amountOver: 50000,
        department: null,
      },
    ],
  },
  {
    id: "multi-three",
    instruction:
      "Add a CFO approval over $50k, send a Slack message when a bill posts, and open a Jira ticket for IT bills",
    minOps: 3,
    why: "three independent changes dispatched in one go",
    stub: [
      {
        op: "add-approval",
        label: "CFO review",
        approverTitle: "CFO",
        amountOver: 50000,
        department: null,
      },
      { op: "add-integration", label: "Notify on Slack", integration: "slack" },
      { op: "add-integration", label: "Open Jira ticket", integration: "jira" },
    ],
  },
  {
    id: "parallel-then-join",
    instruction:
      "After the manager and director reviews, add a final controller sign-off that waits for both",
    minOps: 1,
    why: "an AND-join gate after two steps (add-parallel-after)",
    stub: [
      {
        op: "add-parallel-after",
        afterStepIds: ["manager-review", "director-review"],
        label: "Controller sign-off",
        approverTitle: "Controller",
        amountOver: null,
        department: null,
      },
    ],
  },
  {
    id: "long-sequential-chain",
    instruction:
      "Make approvals fully sequential: after the manager, add a team-lead review, then a finance review, then a controller review, each before the next",
    minOps: 3,
    why: "a multi-step SEQUENTIAL chain (several insert-approval-after in order)",
    stub: [
      {
        op: "insert-approval-after",
        afterStepId: "manager-review",
        label: "Team lead review",
        approverTitle: "Team Lead",
        amountOver: null,
        department: null,
      },
      {
        op: "insert-approval-after",
        afterStepId: "team-lead-review",
        label: "Finance review",
        approverTitle: "Finance",
        amountOver: null,
        department: null,
      },
      {
        op: "insert-approval-after",
        afterStepId: "finance-review",
        label: "Controller review",
        approverTitle: "Controller",
        amountOver: null,
        department: null,
      },
    ],
  },
];
