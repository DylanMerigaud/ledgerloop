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
  parseEditPlan,
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
    vendor: null,
    currency: null,
    matchType: null,
    exceptionCode: null,
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

test("add-approval: builds a vendor / currency / matchType / exceptionCode condition", () => {
  const next = applyEditOp(base, {
    op: "add-approval",
    label: "Vendor review",
    approverTitle: "Buyer",
    amountOver: null,
    department: null,
    vendor: "Severn Steelworks",
    currency: null,
    matchType: null,
    exceptionCode: null,
  });
  const gate = next.steps.find((s) => s.label === "Vendor review");
  assert.ok(gate);
  assert.equal(describeCondition(gate.when), "vendor == Severn Steelworks");

  // Several scope fields AND together into one condition.
  const multi = applyEditOp(base, {
    op: "add-approval",
    label: "FX exception review",
    approverTitle: "Controller",
    amountOver: null,
    department: null,
    vendor: null,
    currency: "EUR",
    matchType: null,
    exceptionCode: "vendor_inactive",
  });
  const fx = multi.steps.find((s) => s.label === "FX exception review");
  assert.ok(fx);
  assert.equal(
    describeCondition(fx.when),
    "currency == EUR and exceptionCode == vendor_inactive",
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
    vendor: null,
    currency: null,
    matchType: null,
    exceptionCode: null,
  });
  const vp = next.steps.find((s) => s.label === "VP sign-off");
  const slack = next.steps.find((s) => s.label === "Slack notify");
  assert.ok(vp && slack);
  // The new gate routes into the ERP post (the join), NOT the trailing Slack node.
  assert.deepEqual(vp.next, ["post"], "VP gate → post (not slack)");
  assert.ok(!slack.next.includes(vp.id), "slack does not point at the gate");
});

test("insert-approval-after: sits the new gate BETWEEN the anchor and what followed", () => {
  // base: manager → {director, post}; director → post. Insert after the director.
  const next = applyEditOp(base, {
    op: "insert-approval-after",
    afterStepId: "director",
    label: "CFO review",
    approverTitle: "CFO",
    amountOver: null,
    department: null,
    vendor: null,
    currency: null,
    matchType: null,
    exceptionCode: null,
  });
  const cfo = next.steps.find((s) => s.label === "CFO review");
  const dir = next.steps.find((s) => s.id === "director");
  assert.ok(cfo && dir);
  assert.deepEqual(
    dir.next,
    [cfo.id],
    "director now points only at the new gate",
  );
  assert.deepEqual(
    cfo.next,
    ["post"],
    "the new gate inherits director's old next",
  );
  assert.doesNotThrow(() => ApprovalWorkflow.parse(next));
});

test("add-parallel-after: new gate waits on ALL anchors, then flows to the post", () => {
  const next = applyEditOp(base, {
    op: "add-parallel-after",
    afterStepIds: ["manager", "director"],
    label: "Final sign-off",
    approverTitle: "Controller",
    amountOver: null,
    department: null,
    vendor: null,
    currency: null,
    matchType: null,
    exceptionCode: null,
  });
  const fin = next.steps.find((s) => s.label === "Final sign-off");
  const mgr = next.steps.find((s) => s.id === "manager");
  const dir = next.steps.find((s) => s.id === "director");
  assert.ok(fin && mgr && dir);
  assert.ok(mgr.next.includes(fin.id), "manager → final");
  assert.ok(dir.next.includes(fin.id), "director → final");
  assert.deepEqual(fin.next, ["post"], "final → post");
  // Anchors no longer race the post directly (manager's old direct post edge dropped).
  assert.ok(
    !mgr.next.includes("post"),
    "manager no longer points straight at post",
  );
  assert.doesNotThrow(() => ApprovalWorkflow.parse(next));
});

test("add-parallel-after that would cycle is rejected (workflow unchanged)", () => {
  // a → b → post. A parallel gate after [a, post] would need post → newGate AND
  // newGate → post (its convergence) = a cycle. The guard returns base untouched.
  const wf: TWorkflow = {
    name: "g",
    roots: ["a"],
    steps: [
      {
        id: "a",
        kind: "approval",
        label: "A",
        when: { kind: "always" },
        approverTitle: "A",
        approverName: "x",
        next: ["b"],
      },
      {
        id: "b",
        kind: "approval",
        label: "B",
        when: { kind: "always" },
        approverTitle: "B",
        approverName: "y",
        next: ["post"],
      },
      {
        id: "post",
        kind: "integration",
        label: "Post",
        when: { kind: "always" },
        integration: "netsuite",
        next: [],
      },
    ],
  };
  const before = JSON.stringify(wf);
  const next = applyEditOp(wf, {
    op: "add-parallel-after",
    afterStepIds: ["a", "post"], // post is the convergence → would loop
    label: "Loopy",
    approverTitle: "X",
    amountOver: null,
    department: null,
    vendor: null,
    currency: null,
    matchType: null,
    exceptionCode: null,
  });
  assert.equal(JSON.stringify(next), before, "cycle guard kept it unchanged");
});

test("reorder-branches: sets the parent's next order, keeps all edges", () => {
  // base: manager → [director, post]. Reorder to [post, director].
  const next = applyEditOp(base, {
    op: "reorder-branches",
    parentStepId: "manager",
    order: ["post", "director"],
  });
  const mgr = next.steps.find((s) => s.id === "manager");
  assert.deepEqual(mgr?.next, ["post", "director"], "order applied");
});

test("reorder-branches: omitted children are kept (no edge dropped)", () => {
  const next = applyEditOp(base, {
    op: "reorder-branches",
    parentStepId: "manager",
    order: ["post"], // director omitted
  });
  const mgr = next.steps.find((s) => s.id === "manager");
  assert.ok(mgr?.next.includes("director"), "omitted child still present");
  assert.ok(mgr?.next.includes("post"));
  assert.equal(mgr?.next.length, 2, "no edge dropped or duplicated");
});

test("rename-step: changes only the label, nothing else", () => {
  const next = applyEditOp(base, {
    op: "rename-step",
    stepId: "director",
    label: "CFO review",
  });
  const dir = next.steps.find((s) => s.id === "director");
  assert.equal(dir?.label, "CFO review");
  // condition + approver + edges untouched
  assert.equal(whenOf(next, "director"), directorWhenText);
  assert.equal(
    dir?.kind === "approval" ? dir.approverName : null,
    "Jordan Ellis",
  );
});

test("duplicate-step: makes a parallel twin with the same successors", () => {
  const next = applyEditOp(base, {
    op: "duplicate-step",
    stepId: "director",
    label: "Second director review",
  });
  const copy = next.steps.find((s) => s.label === "Second director review");
  const mgr = next.steps.find((s) => s.id === "manager");
  assert.ok(copy && mgr);
  // same payload as the original
  assert.equal(whenOf(next, copy.id), directorWhenText);
  // everyone who pointed at the original now also points at the copy
  assert.ok(mgr.next.includes(copy.id), "manager → copy (parallel)");
  assert.deepEqual(copy.next, ["post"], "copy keeps the original's successors");
  assert.doesNotThrow(() => ApprovalWorkflow.parse(next));
});

test("move-step: relocates a step after the anchor", () => {
  // base: manager → {director, post}; director → post. Move director after post.
  const next = applyEditOp(base, {
    op: "move-step",
    stepId: "director",
    afterStepId: "post",
  });
  const mgr = next.steps.find((s) => s.id === "manager");
  const post = next.steps.find((s) => s.id === "post");
  const dir = next.steps.find((s) => s.id === "director");
  assert.ok(mgr && post && dir);
  assert.ok(
    !mgr.next.includes("director"),
    "manager no longer points at director",
  );
  assert.ok(post.next.includes("director"), "post → director (new position)");
  assert.doesNotThrow(() => ApprovalWorkflow.parse(next));
});

test("move-step: extracting a parallel branch into sequence leaves NO stray edge", () => {
  // manager → {dir, dept} (parallel), both → post. Move dept after dir ⇒ a clean
  // chain manager → dir → dept → post, with NO leftover manager → post bypass.
  const wf: TWorkflow = {
    name: "par",
    roots: ["mgr"],
    steps: [
      {
        id: "mgr",
        kind: "approval",
        label: "Manager",
        when: { kind: "always" },
        approverTitle: "M",
        approverName: "x",
        next: ["dir", "dept"],
      },
      {
        id: "dir",
        kind: "approval",
        label: "Director",
        when: { kind: "always" },
        approverTitle: "D",
        approverName: "y",
        next: ["post"],
      },
      {
        id: "dept",
        kind: "approval",
        label: "Dept",
        when: { kind: "always" },
        approverTitle: "H",
        approverName: "z",
        next: ["post"],
      },
      {
        id: "post",
        kind: "integration",
        label: "Post",
        when: { kind: "always" },
        integration: "netsuite",
        next: [],
      },
    ],
  };
  const next = applyEditOp(wf, {
    op: "move-step",
    stepId: "dept",
    afterStepId: "dir",
  });
  const get = (id: string) => next.steps.find((s) => s.id === id);
  assert.deepEqual(
    get("mgr")?.next,
    ["dir"],
    "manager → dir only (no stray post)",
  );
  assert.deepEqual(get("dir")?.next, ["dept"], "dir → dept");
  assert.deepEqual(get("dept")?.next, ["post"], "dept → post");
  assert.doesNotThrow(() => ApprovalWorkflow.parse(next));
});

test("move-step: a linear-chain move still bypasses (keeps flow)", () => {
  // a → b → c. Move b after c: a had ONLY b, so a must bypass to b's old next (c).
  const wf: TWorkflow = {
    name: "lin",
    roots: ["a"],
    steps: [
      {
        id: "a",
        kind: "approval",
        label: "A",
        when: { kind: "always" },
        approverTitle: "A",
        approverName: "x",
        next: ["b"],
      },
      {
        id: "b",
        kind: "approval",
        label: "B",
        when: { kind: "always" },
        approverTitle: "B",
        approverName: "y",
        next: ["c"],
      },
      {
        id: "c",
        kind: "integration",
        label: "C",
        when: { kind: "always" },
        integration: "netsuite",
        next: [],
      },
    ],
  };
  const next = applyEditOp(wf, {
    op: "move-step",
    stepId: "b",
    afterStepId: "c",
  });
  const get = (id: string) => next.steps.find((s) => s.id === id);
  assert.deepEqual(
    get("a")?.next,
    ["c"],
    "a bypasses to c (would be orphaned otherwise)",
  );
  assert.deepEqual(get("c")?.next, ["b"], "c → b (new position)");
  assert.doesNotThrow(() => ApprovalWorkflow.parse(next));
});

test("move-step keeps the graph acyclic (it unhooks before re-inserting)", () => {
  // move-step always detaches the step (predecessors bypass it) before re-parenting
  // it under the anchor, so it can't introduce a back-edge — the result stays a DAG
  // whatever the source/anchor. A self-move (anchor === step) is a no-op.
  const self = applyEditOp(base, {
    op: "move-step",
    stepId: "director",
    afterStepId: "director",
  });
  assert.equal(
    JSON.stringify(self),
    JSON.stringify(base),
    "moving a step after itself is a no-op",
  );
  // A real move still validates as a sound DAG (no cycle introduced).
  const moved = applyEditOp(base, {
    op: "move-step",
    stepId: "director",
    afterStepId: "manager",
  });
  assert.doesNotThrow(() => ApprovalWorkflow.parse(moved));
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
    vendor: null,
    currency: null,
    matchType: null,
    exceptionCode: null,
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
        vendor: null,
        currency: null,
        matchType: null,
        exceptionCode: null,
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

test("a clarify op leaves the workflow untouched (it's a question, not an edit)", () => {
  const next = applyEditOp(base, {
    op: "clarify",
    question: "Which department?",
    options: ["Finance", "Product"],
  });
  assert.deepEqual(next, base, "clarify changes nothing");
});

test("parseEditPlan accepts a clarify op in the plan", () => {
  const ops = parseEditPlan({
    ops: [
      { op: "clarify", question: "Which department?", options: ["Finance"] },
    ],
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.op, "clarify");
});
