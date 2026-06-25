import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApprovalWorkflow, WorkflowStep } from "@/lib/approval-workflow";
import {
  validateWorkflow,
  isActivatable,
  MATERIALITY,
} from "@/lib/workflow-validate";

/**
 * The validator is the tool that decides whether a workflow "makes sense" — both
 * structurally (a sound DAG that posts) and against AP controls (segregation of
 * duties, a second approver on high-value spend, etc.). Each check is pinned here.
 */

/** A clean, sound template: manager → director(>25k) → IT dept → post. */
const sound = (): ApprovalWorkflow => ({
  name: "sound",
  roots: ["manager"],
  steps: [
    {
      id: "manager",
      kind: "approval",
      label: "Manager review",
      when: { kind: "always" },
      approverTitle: "Manager",
      approverName: "Riley Carter",
      next: ["director", "dept"],
    },
    {
      id: "director",
      kind: "approval",
      label: "Director review",
      when: { kind: "leaf", field: "amount", op: ">", value: 25000 },
      approverTitle: "CFO",
      approverName: "Cameron Diaz",
      next: ["post"],
    },
    {
      id: "dept",
      kind: "approval",
      label: "Department head review",
      when: { kind: "leaf", field: "department", op: "==", value: "IT" },
      approverTitle: "COO",
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
});

const codes = (wf: ApprovalWorkflow): string[] =>
  validateWorkflow(wf).map((i) => i.code);

test("a sound template validates with zero issues", () => {
  const issues = validateWorkflow(sound());
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2));
  assert.equal(isActivatable(issues), true);
});

test("dangling edge is an error", () => {
  const wf = sound();
  wf.steps[0]!.next = ["director", "ghost"];
  assert.ok(codes(wf).includes("dangling-edge"));
  assert.equal(isActivatable(validateWorkflow(wf)), false);
});

test("no roots is an error", () => {
  const wf = sound();
  wf.roots = [];
  assert.ok(codes(wf).includes("no-roots"));
});

test("a cycle is an error", () => {
  const wf = sound();
  // make post point back to manager
  wf.steps[3]!.next = ["manager"];
  assert.ok(codes(wf).includes("cycle"));
});

test("an unreachable step is an error", () => {
  const wf = sound();
  const orphan: WorkflowStep = {
    id: "orphan",
    kind: "approval",
    label: "Orphan",
    when: { kind: "always" },
    approverTitle: "X",
    approverName: "Nobody",
    next: [],
  };
  wf.steps.push(orphan);
  assert.ok(codes(wf).includes("unreachable-step"));
});

test("no posting step is an error", () => {
  const wf = sound();
  // turn the post into a non-terminal by removing it and re-pointing
  wf.steps = wf.steps.filter((s) => s.id !== "post");
  wf.steps.forEach((s) => (s.next = s.next.filter((n) => n !== "post")));
  assert.ok(codes(wf).includes("no-post"));
});

test("unresolved approver is a warning, not blocking", () => {
  const wf = sound();
  const dir = wf.steps[1];
  if (dir?.kind === "approval") dir.approverName = null;
  const issues = validateWorkflow(wf);
  assert.ok(issues.some((i) => i.code === "unresolved-approver"));
  assert.equal(isActivatable(issues), true); // warning doesn't block
});

test("duplicate gate (same role + scope) is a warning", () => {
  const wf = sound();
  wf.steps.push({
    id: "dept2",
    kind: "approval",
    label: "Department head review 2",
    when: { kind: "leaf", field: "department", op: "==", value: "IT" },
    approverTitle: "COO",
    approverName: "Jordan Ellis",
    next: ["post"],
  });
  wf.steps[0]!.next = ["director", "dept", "dept2"];
  assert.ok(codes(wf).includes("duplicate-gate"));
});

test("same person approving twice on a path → segregation-of-duties", () => {
  const wf = sound();
  // make the director the same person as the manager
  const dir = wf.steps[1];
  if (dir?.kind === "approval") dir.approverName = "Riley Carter";
  assert.ok(codes(wf).includes("segregation-of-duties"));
});

test("high-value path with one approver → single-approver-high-value", () => {
  const wf: ApprovalWorkflow = {
    name: "single",
    roots: ["m"],
    steps: [
      {
        id: "m",
        kind: "approval",
        label: "Manager review",
        when: {
          kind: "leaf",
          field: "amount",
          op: ">",
          value: MATERIALITY + 1,
        },
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
  assert.ok(codes(wf).includes("single-approver-high-value"));
});

test("a path that posts with no human gate → no-human-approval", () => {
  const wf: ApprovalWorkflow = {
    name: "nohuman",
    roots: ["post"],
    steps: [
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
  assert.ok(codes(wf).includes("no-human-approval"));
});
