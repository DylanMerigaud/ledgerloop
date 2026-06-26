import assert from "node:assert/strict";
import { test } from "node:test";

import { executeWorkflow, type Decisions } from "@/lib/approval-engine";
import {
  type ApprovalWorkflow,
  type InvoiceContext,
} from "@/lib/approval-workflow";

/**
 * The engine drives payment routing, so it's tested exhaustively. The fixture is
 * the template the onboarding agent produces: manager (always) fans out to a
 * director (amount > 5000) and a department review (dept == IT); both gates feed
 * the NetSuite post. There is NO direct manager→post edge — the post is reached
 * for a small/non-IT invoice because skipped gates pass through (AND-join).
 */
const wf: ApprovalWorkflow = {
  name: "test",
  roots: ["manager"],
  steps: [
    {
      id: "manager",
      kind: "approval",
      label: "Manager review",
      when: { kind: "always" },
      approverTitle: "Manager",
      approverName: "Esther Howard",
      next: ["director", "it"],
    },
    {
      id: "director",
      kind: "approval",
      label: "Director review",
      when: { kind: "leaf", field: "amount", op: ">", value: 5000 },
      approverTitle: "Director",
      approverName: "Jordan Ellis",
      next: ["post"],
    },
    {
      id: "it",
      kind: "approval",
      label: "IT review",
      when: { kind: "leaf", field: "department", op: "==", value: "IT" },
      approverTitle: "VP of IT",
      approverName: "Mark Davis",
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

const ctx = (over: Partial<InvoiceContext> = {}): InvoiceContext => ({
  amount: 1000,
  exceptionAmount: 0,
  variancePct: 0,
  department: "Finance",
  verdict: "clean",
  vendor: "Acme",
  currency: "USD",
  matchType: "three_way",
  exceptionCodes: [],
  ...over,
});

const status = (s: ReturnType<typeof executeWorkflow>, id: string) =>
  s.steps.find((x) => x.id === id)!.status;

test("fresh run: only the manager is pending; gated + downstream wait", () => {
  const s = executeWorkflow(wf, ctx({ amount: 9000, department: "IT" }));
  assert.deepEqual(s.pending, ["manager"]);
  assert.equal(s.outcome, "awaiting");
  // director/it are gated-true but blocked behind the pending manager.
  assert.equal(status(s, "director"), "blocked");
  assert.equal(status(s, "it"), "blocked");
  assert.equal(status(s, "post"), "blocked");
});

test("small Finance invoice: after manager approves, the gated steps skip and post runs", () => {
  const decisions: Decisions = { manager: "approve" };
  const s = executeWorkflow(
    wf,
    ctx({ amount: 1000, department: "Finance" }),
    decisions,
  );
  assert.equal(status(s, "manager"), "approved");
  assert.equal(status(s, "director"), "skipped"); // amount <= 5000
  assert.equal(status(s, "it"), "skipped"); // dept != IT
  assert.equal(status(s, "post"), "done"); // reached via the approved manager
  assert.equal(s.outcome, "approved");
  assert.equal(s.pending.length, 0);
});

test("collect-all: a big IT invoice surfaces BOTH director and IT pending at once", () => {
  const s = executeWorkflow(wf, ctx({ amount: 9000, department: "IT" }), {
    manager: "approve",
  });
  assert.deepEqual([...s.pending].sort(), ["director", "it"]);
  assert.equal(s.outcome, "awaiting");
  assert.equal(status(s, "post"), "blocked"); // waits for both
});

test("post runs only once every active approval is approved", () => {
  const s = executeWorkflow(wf, ctx({ amount: 9000, department: "IT" }), {
    manager: "approve",
    director: "approve",
    it: "approve",
  });
  assert.equal(status(s, "post"), "done");
  assert.equal(s.outcome, "approved");
});

test("partial approval still waits on the remaining branch", () => {
  const s = executeWorkflow(
    wf,
    ctx({ amount: 9000, department: "IT" }),
    { manager: "approve", director: "approve" }, // it still pending
  );
  assert.deepEqual(s.pending, ["it"]);
  assert.equal(status(s, "post"), "blocked");
  assert.equal(s.outcome, "awaiting");
});

test("a rejection blocks everything downstream and the post never runs", () => {
  const s = executeWorkflow(wf, ctx({ amount: 9000, department: "IT" }), {
    manager: "approve",
    director: "reject",
    it: "approve",
  });
  assert.equal(status(s, "director"), "rejected");
  assert.equal(status(s, "post"), "blocked");
  assert.equal(s.outcome, "rejected");
});

test("manager rejection blocks the whole tree", () => {
  const s = executeWorkflow(wf, ctx({ amount: 9000 }), { manager: "reject" });
  assert.equal(status(s, "manager"), "rejected");
  assert.equal(status(s, "director"), "blocked");
  assert.equal(status(s, "post"), "blocked");
  assert.equal(s.outcome, "rejected");
});

test("director gates exactly at the threshold (strict >)", () => {
  const at = executeWorkflow(wf, ctx({ amount: 5000 }), { manager: "approve" });
  assert.equal(status(at, "director"), "skipped"); // 5000 is not > 5000
  const over = executeWorkflow(wf, ctx({ amount: 5001 }), {
    manager: "approve",
  });
  assert.equal(status(over, "director"), "pending");
});

test("every step is accounted for in the snapshot", () => {
  const s = executeWorkflow(wf, ctx());
  assert.equal(s.steps.length, wf.steps.length);
});

/* The workflowFromPolicy topology: the manager gate is itself conditional
   (verdict == exception), not always. A CLEAN invoice skips every gate — and the
   post must STILL run (a skipped gate is a pass-through, not a dead branch). This
   is the case the naive "all parents skipped → skip" rule got wrong. */
test("clean invoice through a conditional-manager workflow still posts", () => {
  const conditionalWf: ApprovalWorkflow = {
    name: "from-policy",
    roots: ["manager"],
    steps: [
      {
        id: "manager",
        kind: "approval",
        label: "Manager review",
        when: { kind: "leaf", field: "verdict", op: "==", value: "exception" },
        approverTitle: "Manager",
        approverName: null,
        next: ["director", "post"],
      },
      {
        id: "director",
        kind: "approval",
        label: "Director review",
        when: { kind: "leaf", field: "verdict", op: "==", value: "exception" },
        approverTitle: "Director",
        approverName: null,
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
  const s = executeWorkflow(conditionalWf, ctx({ verdict: "clean" }));
  assert.equal(status(s, "manager"), "skipped");
  assert.equal(status(s, "director"), "skipped");
  assert.equal(status(s, "post"), "done"); // pass-through, not skipped
  assert.equal(s.outcome, "approved");
});
