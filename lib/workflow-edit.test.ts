import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApprovalWorkflow,
  diffWorkflows,
  describeCondition,
  type ApprovalWorkflow as TWorkflow,
} from "@/lib/approval-workflow";
import {
  applyEditOp,
  proposeEdit,
  type EditModel,
  type WorkflowEditOp,
} from "@/lib/workflow-edit";

/**
 * The edit is deterministic: the model only picks an op (tested live in the eval);
 * `applyEditOp` does the structural change and is the part that must be exact —
 * crucially, it must NEVER touch unrelated steps or their conditions (the bug the
 * old full-workflow-round-trip had). These pin that.
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
      approverName: "Esther Howard",
      next: ["director", "post"],
    },
    {
      id: "director",
      kind: "approval",
      label: "Director review",
      // A NESTED condition — the exact shape the old model dropped.
      when: {
        kind: "all",
        conditions: [
          { kind: "leaf", field: "verdict", op: "==", value: "exception" },
          {
            kind: "any",
            conditions: [
              { kind: "leaf", field: "amount", op: ">=", value: 10000 },
              { kind: "leaf", field: "variancePct", op: ">=", value: 0.1 },
            ],
          },
        ],
      },
      approverTitle: "Director",
      approverName: "Jordan Ellis",
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

/** Helper: a step's condition text by id (throws if missing — fine in a test). */
const whenOf = (wf: TWorkflow, id: string): string => {
  const step = wf.steps.find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return describeCondition(step.when);
};

const directorWhenText = whenOf(base, "director");

test("add-approval: adds a gate, wires it, leaves every other step untouched", () => {
  const op: WorkflowEditOp = {
    op: "add-approval",
    label: "CFO approval",
    approverTitle: "CFO",
    amountOver: 50000,
    department: null,
  };
  const next = applyEditOp(base, op);
  assert.doesNotThrow(() => ApprovalWorkflow.parse(next));

  const cfo = next.steps.find((s) => s.label === "CFO approval");
  assert.ok(cfo, "CFO gate added");
  assert.equal(
    describeCondition(cfo.when),
    "amount > $50,000",
    "condition built from the threshold",
  );
  // The director's NESTED condition is byte-for-byte intact (the old bug).
  assert.equal(whenOf(next, "director"), directorWhenText);
  const changes = diffWorkflows(base, next);
  assert.equal(
    changes.find((c) => c.id === "director")?.kind,
    "unchanged",
    "director must not be touched",
  );
});

test("add-integration: runs after the post, doesn't alter other conditions", () => {
  const next = applyEditOp(base, {
    op: "add-integration",
    label: "Slack notify",
    integration: "slack",
  });
  const slack = next.steps.find((s) => s.label === "Slack notify");
  assert.ok(slack);
  assert.equal(slack.kind, "integration");
  const post = next.steps.find((s) => s.id === "post");
  assert.ok(post?.next.includes(slack.id), "post routes into slack");
  assert.equal(
    whenOf(next, "director"),
    directorWhenText,
    "director condition untouched",
  );
});

test("a SECOND notification still branches off the ERP post, not the first", () => {
  // Regression: postStepId used to return "the integration with no outgoing edge",
  // so once Slack trailed the post, a second notification chained off Slack and an
  // added approval converged on Slack — tangling the graph. The post must stay the
  // join node regardless of trailing notifications.
  const withSlack = applyEditOp(base, {
    op: "add-integration",
    label: "Slack notify",
    integration: "slack",
  });
  const withJira = applyEditOp(withSlack, {
    op: "add-integration",
    label: "Jira ticket",
    integration: "jira",
  });
  const post = withJira.steps.find((s) => s.id === "post");
  const slack = withJira.steps.find((s) => s.label === "Slack notify");
  const jira = withJira.steps.find((s) => s.label === "Jira ticket");
  assert.ok(post && slack && jira);
  // Both notifications hang off the post in parallel; neither chains off the other.
  assert.ok(post.next.includes(slack.id), "post → slack");
  assert.ok(post.next.includes(jira.id), "post → jira");
  assert.deepEqual(slack.next, [], "slack has no trailing edge");
  assert.deepEqual(jira.next, [], "jira has no trailing edge");
});

test("an approval added AFTER a notification converges on the ERP post", () => {
  const withSlack = applyEditOp(base, {
    op: "add-integration",
    label: "Slack notify",
    integration: "slack",
  });
  const next = applyEditOp(withSlack, {
    op: "add-approval",
    label: "VP sign-off",
    approverTitle: "VP",
    amountOver: 100000,
    department: null,
  });
  const vp = next.steps.find((s) => s.label === "VP sign-off");
  const slack = next.steps.find((s) => s.label === "Slack notify");
  assert.ok(vp && slack);
  // The new gate routes into the ERP post (the join), NOT the trailing Slack node.
  assert.deepEqual(vp.next, ["post"], "VP gate → post (not slack)");
  assert.ok(!slack.next.includes(vp.id), "slack does not point at the gate");
});

test("set-threshold: changes only the targeted gate's amount", () => {
  const next = applyEditOp(base, {
    op: "set-threshold",
    stepId: "director",
    amountOver: 25000,
  });
  const w = whenOf(next, "director");
  assert.match(w, /amount > \$25,000/);
  assert.match(w, /verdict == exception/);
});

test("set-approver: sets the person on one step only", () => {
  const next = applyEditOp(base, {
    op: "set-approver",
    stepId: "director",
    approverName: "Cameron Diaz",
  });
  const dir = next.steps.find((s) => s.id === "director");
  assert.equal(dir?.kind === "approval" && dir.approverName, "Cameron Diaz");
  const mgr = next.steps.find((s) => s.id === "manager");
  assert.equal(mgr?.kind === "approval" && mgr.approverName, "Esther Howard");
});

test("remove-step: drops the step and every edge into it", () => {
  const next = applyEditOp(base, { op: "remove-step", stepId: "director" });
  assert.ok(!next.steps.some((s) => s.id === "director"));
  assert.ok(!next.steps.some((s) => s.next.includes("director")));
});

test("none: changes nothing", () => {
  const next = applyEditOp(base, { op: "none", reason: "already the case" });
  assert.deepEqual(next, base);
  assert.ok(diffWorkflows(base, next).every((c) => c.kind === "unchanged"));
});

test("applyEditOp never mutates the input workflow", () => {
  const before = JSON.stringify(base);
  applyEditOp(base, {
    op: "add-approval",
    label: "X",
    approverTitle: "X",
    amountOver: 1,
    department: null,
  });
  assert.equal(JSON.stringify(base), before);
});

test("proposeEdit runs the model -> op -> apply -> diff", async () => {
  const fake: EditModel = {
    planEdit: () =>
      Promise.resolve<WorkflowEditOp>({
        op: "add-approval",
        label: "CFO approval",
        approverTitle: "CFO",
        amountOver: 50000,
        department: null,
      }),
  };
  const { proposed, op, changes } = await proposeEdit(
    fake,
    base,
    "above 50k add CFO",
  );
  assert.equal(op.op, "add-approval");
  assert.doesNotThrow(() => ApprovalWorkflow.parse(proposed));
  assert.ok(changes.some((c) => c.kind === "added"));
});
