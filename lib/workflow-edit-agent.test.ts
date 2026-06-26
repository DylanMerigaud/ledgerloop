import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApprovalWorkflow as TWorkflow } from "@/lib/approval-workflow";
import type { WorkflowEditOp } from "@/lib/workflow-edit";
import { runEditAgent, type PlanModel } from "@/lib/workflow-edit-agent";

/**
 * The agent's ORCHESTRATION is what's tested here (the model is faked): it applies a
 * planned op list in order, validates with the validator, and on errors feeds them
 * back for a correction pass. The model itself (op selection) is exercised live in
 * the eval.
 */

const base: TWorkflow = {
  name: "base",
  roots: ["manager"],
  steps: [
    {
      id: "manager",
      kind: "approval",
      label: "Manager review",
      when: { kind: "always" },
      approverTitle: "Manager",
      approverName: "Riley Carter",
      next: ["post"],
    },
    {
      id: "post",
      kind: "integration",
      label: "Post to NetSuite",
      when: { kind: "always" },
      integration: "netsuite",
      next: [],
    },
  ],
};

test("dispatches a multi-op plan in order (one round)", async () => {
  const model: PlanModel = {
    planOps: () =>
      Promise.resolve<WorkflowEditOp[]>([
        {
          op: "add-approval",
          label: "CFO review",
          approverTitle: "CFO",
          amountOver: 50000,
          department: null,
          vendor: null,
          currency: null,
          matchType: null,
          exceptionCode: null,
        },
        {
          op: "add-integration",
          label: "Notify on Slack",
          integration: "slack",
        },
      ]),
  };
  const { proposed, ops, changes } = await runEditAgent(
    model,
    base,
    "add a CFO gate over 50k and a Slack notice",
    { departments: [], vendors: [], currencies: [] },
  );
  assert.equal(ops.length, 2, "both ops applied");
  assert.ok(proposed.steps.some((s) => s.label === "CFO review"));
  assert.ok(proposed.steps.some((s) => s.label === "Notify on Slack"));
  assert.ok(changes.some((c) => c.kind === "added"));
});

test("on an erroring plan, it re-plans with the validator's errors as feedback", async () => {
  // The defining agentic behaviour: if the first plan leaves the workflow with a
  // validation ERROR, the agent calls the planner AGAIN and hands it those errors so
  // it can correct. (We assert the feedback contract — the loop's correction round.)
  let sawFeedbackError = false;
  let call = 0;
  const model: PlanModel = {
    planOps: ({ feedback }) => {
      call++;
      if (feedback?.issues.some((i) => i.severity === "error"))
        sawFeedbackError = true;
      if (call === 1) {
        // remove the post → "no-post" / "post-not-reached" error
        return Promise.resolve<WorkflowEditOp[]>([
          { op: "remove-step", stepId: "post" },
        ]);
      }
      return Promise.resolve<WorkflowEditOp[]>([]); // give up on the correction
    },
  };
  await runEditAgent(model, base, "tidy up", {
    departments: [],
    vendors: [],
    currencies: [],
  });
  assert.equal(call >= 2, true, "it ran a correction round");
  assert.equal(
    sawFeedbackError,
    true,
    "the errors were fed back to the planner",
  );
});

test("returns a reason when the plan is all no-ops (no change)", async () => {
  const model: PlanModel = {
    planOps: () =>
      Promise.resolve<WorkflowEditOp[]>([
        { op: "none", reason: "already does that" },
      ]),
  };
  const { changes, reason } = await runEditAgent(
    model,
    base,
    "do nothing useful",
    { departments: [], vendors: [], currencies: [] },
  );
  assert.equal(
    changes.filter((c) => c.kind !== "unchanged").length,
    0,
    "no real change",
  );
  assert.match(reason ?? "", /already does that/);
});

test("a clarify op short-circuits: workflow unchanged, clarification surfaced", async () => {
  // When the model can't resolve a slot (which department?), it returns a clarify op.
  // The agent must NOT apply anything and must surface the question + options.
  const model: PlanModel = {
    planOps: () =>
      Promise.resolve<WorkflowEditOp[]>([
        {
          op: "clarify",
          question: "Which department?",
          options: ["Finance", "Product"],
        },
      ]),
  };
  const result = await runEditAgent(model, base, "add a department review", {
    departments: ["Finance", "Product"],
    vendors: [],
    currencies: [],
  });
  assert.deepEqual(
    result.clarify,
    { question: "Which department?", options: ["Finance", "Product"] },
    "the clarification is surfaced",
  );
  assert.equal(result.proposed, base, "the workflow is left unchanged");
  assert.equal(
    result.changes.filter((c) => c.kind !== "unchanged").length,
    0,
    "no edit applied",
  );
});

test("a complete instruction applies normally (clarify stays null)", async () => {
  const model: PlanModel = {
    planOps: () =>
      Promise.resolve<WorkflowEditOp[]>([
        {
          op: "add-approval",
          label: "Finance review",
          approverTitle: "Finance",
          amountOver: null,
          department: "Finance",
          vendor: null,
          currency: null,
          matchType: null,
          exceptionCode: null,
        },
      ]),
  };
  const result = await runEditAgent(model, base, "add a Finance review", {
    departments: ["Finance"],
    vendors: [],
    currencies: [],
  });
  assert.equal(result.clarify, null, "no clarification needed");
  assert.ok(result.proposed.steps.some((s) => s.label === "Finance review"));
});

test("stops at the step budget on a stubborn error (doesn't hang)", async () => {
  // The model keeps removing the post (always leaving a no-post error) — the loop
  // must terminate at the budget rather than spin forever.
  let calls = 0;
  const model: PlanModel = {
    planOps: () => {
      calls++;
      return Promise.resolve<WorkflowEditOp[]>([
        { op: "remove-step", stepId: "post" },
      ]);
    },
  };
  const { issues } = await runEditAgent(model, base, "break it", {
    departments: [],
    vendors: [],
    currencies: [],
  });
  assert.ok(calls <= 4, "bounded to the step budget");
  // It returns (doesn't hang); the remaining error is surfaced.
  assert.ok(issues.some((i) => i.severity === "error"));
});
