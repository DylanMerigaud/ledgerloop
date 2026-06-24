import assert from "node:assert/strict";
import { test } from "node:test";

import { diffWorkflows, type ApprovalWorkflow } from "@/lib/approval-workflow";
import { proposeEdit, type EditModel } from "@/lib/workflow-edit";

/**
 * The diff is what the preview renders and what makes "approve/revert" meaningful,
 * so it's pinned exactly. The edit flow itself is exercised with an injected fake
 * model (the real one is a live structured-output call).
 */

const base: ApprovalWorkflow = {
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

/** Deep clone so edits don't mutate the base fixture. */
const clone = (w: ApprovalWorkflow): ApprovalWorkflow =>
  JSON.parse(JSON.stringify(w));

test("identical workflows diff as all unchanged", () => {
  const changes = diffWorkflows(base, clone(base));
  assert.ok(changes.every((c) => c.kind === "unchanged"));
});

test("an added step shows as added", () => {
  const proposed = clone(base);
  proposed.steps[0]!.next = ["cfo", "post"];
  proposed.steps.push({
    id: "cfo",
    kind: "approval",
    label: "CFO approval",
    when: { kind: "leaf", field: "amount", op: ">", value: 10000 },
    approverTitle: "CFO",
    approverName: null,
    next: ["post"],
  });
  const changes = diffWorkflows(base, proposed);
  const added = changes.find((c) => c.id === "cfo");
  assert.equal(added?.kind, "added");
  // The manager step changed (its routing now includes cfo).
  const mgr = changes.find((c) => c.id === "manager");
  assert.equal(mgr?.kind, "changed");
  assert.ok(mgr?.kind === "changed" && mgr.fields.includes("routing"));
});

test("a removed step shows as removed", () => {
  const proposed = clone(base);
  proposed.steps = proposed.steps.filter((s) => s.id !== "post");
  proposed.steps[0]!.next = [];
  const changes = diffWorkflows(base, proposed);
  assert.equal(changes.find((c) => c.id === "post")?.kind, "removed");
});

test("a changed condition / approver is detected with the right fields", () => {
  const proposed = clone(base);
  const mgr = proposed.steps[0]!;
  if (mgr.kind === "approval") {
    mgr.approverName = "Riley Carter";
    mgr.when = { kind: "leaf", field: "amount", op: ">", value: 500 };
  }
  const changes = diffWorkflows(base, proposed);
  const c = changes.find((x) => x.id === "manager");
  assert.equal(c?.kind, "changed");
  assert.ok(c?.kind === "changed" && c.fields.includes("approver"));
  assert.ok(c?.kind === "changed" && c.fields.includes("condition"));
});

test("proposeEdit returns the proposal + its diff, without mutating current", () => {
  const fake: EditModel = {
    edit: async (current) => {
      const next = clone(current);
      next.name = "edited";
      next.steps[0]!.label = "Manager sign-off";
      return next;
    },
  };
  const before = JSON.stringify(base);
  return proposeEdit(fake, base, "rename the manager step").then((res) => {
    assert.equal(res.proposed.name, "edited");
    assert.ok(
      res.changes.some((c) => c.kind === "changed" && c.id === "manager"),
    );
    assert.equal(JSON.stringify(base), before, "current must not be mutated");
  });
});
