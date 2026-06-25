import type { ApprovalWorkflow } from "@/lib/approval-workflow";
import type { WorkflowEditOp } from "@/lib/workflow-edit";

/**
 * Corpus for the conversational-edit eval. Each case is a plain-language
 * instruction against a known workflow, with the op the model SHOULD pick. We
 * score the op kind (always) and the parameters that matter for that kind
 * (threshold, integration, target step) — not the prose. The interesting cases are
 * the "none" ones: an instruction that asks for something already true must NOT
 * invent a redundant edit (the false-positive the hardcoded suggestions had).
 */

/** A small workflow the cases run against — manager → director(>10k) → IT → post. */
export const EDIT_FIXTURE: ApprovalWorkflow = {
  name: "fixture",
  roots: ["manager-review"],
  steps: [
    {
      id: "manager-review",
      kind: "approval",
      label: "Manager review",
      when: { kind: "always" },
      approverTitle: "Manager",
      approverName: "Riley Carter",
      next: ["director-review", "it-review", "post-netsuite"],
    },
    {
      id: "director-review",
      kind: "approval",
      label: "Director review",
      when: { kind: "leaf", field: "amount", op: ">", value: 10000 },
      approverTitle: "Director",
      approverName: "Cameron Diaz",
      next: ["post-netsuite"],
    },
    {
      id: "it-review",
      kind: "approval",
      label: "IT review",
      when: { kind: "leaf", field: "department", op: "==", value: "IT" },
      approverTitle: "VP of IT",
      approverName: null,
      next: ["post-netsuite"],
    },
    {
      id: "post-netsuite",
      kind: "integration",
      label: "Post to NetSuite",
      when: { kind: "always" },
      integration: "netsuite",
      next: [],
    },
  ],
};

/** What we assert about the chosen op. `check` runs against the actual op. */
export type EditCase = {
  id: string;
  instruction: string;
  expectedOp: WorkflowEditOp["op"];
  /** Extra param assertion for the chosen op (returns true if acceptable). */
  check?: (op: WorkflowEditOp) => boolean;
  why: string;
};

export const EDIT_CASES: EditCase[] = [
  {
    id: "add-cfo-threshold",
    instruction: "Above $50,000, also require CFO approval",
    expectedOp: "add-approval",
    check: (op) =>
      op.op === "add-approval" &&
      op.amountOver === 50000 &&
      /cfo|chief financial/i.test(op.approverTitle),
    why: "a new gate above a NEW threshold (50k ≠ the existing 10k director)",
  },
  {
    id: "add-slack",
    instruction: "Send a Slack message whenever an invoice is posted",
    expectedOp: "add-integration",
    check: (op) => op.op === "add-integration" && op.integration === "slack",
    why: "a Slack integration after the post",
  },
  {
    id: "add-jira",
    instruction: "Open a Jira ticket for every invoice that posts",
    expectedOp: "add-integration",
    check: (op) => op.op === "add-integration" && op.integration === "jira",
    why: "a Jira integration",
  },
  {
    id: "raise-director-threshold",
    instruction: "Bump the director approval threshold up to $20,000",
    expectedOp: "set-threshold",
    check: (op) => op.op === "set-threshold" && op.stepId === "director-review",
    why: "change the existing director gate's threshold, not add a new one",
  },
  {
    id: "assign-it-approver",
    instruction: "Make Sam Patel the IT review approver",
    expectedOp: "set-approver",
    check: (op) =>
      op.op === "set-approver" &&
      op.stepId === "it-review" &&
      /sam patel/i.test(op.approverName),
    why: "set the person on the existing IT gate",
  },
  {
    id: "drop-it",
    instruction: "Remove the IT review step entirely",
    expectedOp: "remove-step",
    check: (op) => op.op === "remove-step" && op.stepId === "it-review",
    why: "remove the IT gate",
  },
  {
    id: "already-has-director",
    instruction: "Make sure invoices over $10,000 get a director sign-off",
    expectedOp: "none",
    why: "the director gate already fires at >10k — must NOT add a redundant gate",
  },
  {
    id: "nonsense",
    instruction: "Change the company logo to blue",
    expectedOp: "none",
    why: "nothing about approvals — must decline, not invent an edit",
  },
];
