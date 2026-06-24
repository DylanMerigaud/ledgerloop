import assert from "node:assert/strict";
import { test } from "node:test";

import { executeWorkflow } from "@/lib/approval-engine";
import { ApprovalWorkflow, type InvoiceContext } from "@/lib/approval-workflow";
import {
  workflowFromPolicy,
  workflowFor,
  DEFAULT_APPROVAL_POLICY,
  type ApprovalPolicy,
} from "@/lib/client-profile";

/**
 * The DAG bridge must reproduce the OLD flat two-tier behaviour, so migrating the
 * pipeline onto the engine changes nothing for an un-onboarded profile:
 *   clean      → no gate, posts straight through
 *   exception  → manager gate; director also when amount/variance clears the bar
 *   (duplicate is a pre-workflow control, not exercised here)
 */

const ctx = (over: Partial<InvoiceContext>): InvoiceContext => ({
  amount: 1000,
  exceptionAmount: 0,
  variancePct: 0,
  department: "Finance",
  verdict: "clean",
  ...over,
});

test("workflowFromPolicy produces a valid workflow", () => {
  assert.doesNotThrow(() =>
    ApprovalWorkflow.parse(workflowFromPolicy(DEFAULT_APPROVAL_POLICY)),
  );
});

test("clean invoice: no gate fires, the bill posts", () => {
  const wf = workflowFromPolicy(DEFAULT_APPROVAL_POLICY);
  const s = executeWorkflow(wf, ctx({ verdict: "clean" }));
  assert.equal(s.outcome, "approved");
  assert.equal(s.pending.length, 0);
  assert.equal(s.steps.find((x) => x.id === "post-netsuite")!.status, "done");
});

test("small exception: only the manager gate fires, not the director", () => {
  const wf = workflowFromPolicy(DEFAULT_APPROVAL_POLICY); // dir at 10k / 10%
  const s = executeWorkflow(
    wf,
    ctx({
      verdict: "exception",
      amount: 2000,
      exceptionAmount: 60,
      variancePct: 0.06,
    }),
  );
  assert.deepEqual(s.pending, ["manager-review"]);
  assert.equal(
    s.steps.find((x) => x.id === "director-review")!.status,
    "blocked", // gated-but-behind the pending manager; not yet skipped/active
  );
});

test("big exception by amount: director gate also fires after the manager", () => {
  const wf = workflowFromPolicy(DEFAULT_APPROVAL_POLICY);
  const s = executeWorkflow(
    wf,
    ctx({
      verdict: "exception",
      amount: 15000,
      exceptionAmount: 15000,
      variancePct: 0.03,
    }),
    { "manager-review": "approve" },
  );
  // amount 15000 >= director 10000 → director now pending.
  assert.deepEqual(s.pending, ["director-review"]);
});

test("big exception by variance alone: director still escalates", () => {
  const wf = workflowFromPolicy(DEFAULT_APPROVAL_POLICY);
  const s = executeWorkflow(
    wf,
    ctx({
      verdict: "exception",
      amount: 500,
      exceptionAmount: 500,
      variancePct: 0.2,
    }),
    { "manager-review": "approve" },
  );
  // variance 0.2 >= director 0.1 → escalates despite the small amount.
  assert.deepEqual(s.pending, ["director-review"]);
});

test("a stricter profile escalates a smaller exception to the director", () => {
  const strict: ApprovalPolicy = {
    manager: { amount: 500, variancePct: 0.02 },
    director: { amount: 5_000, variancePct: 0.05 },
  };
  const wf = workflowFromPolicy(strict);
  const s = executeWorkflow(
    wf,
    ctx({
      verdict: "exception",
      amount: 6000,
      exceptionAmount: 6000,
      variancePct: 0.03,
    }),
    { "manager-review": "approve" },
  );
  // 6000 >= 5000 → director fires under the strict profile (wouldn't under default).
  assert.deepEqual(s.pending, ["director-review"]);
});

test("workflowFor returns the explicit workflow when present, else the derived one", () => {
  const explicit = workflowFromPolicy(DEFAULT_APPROVAL_POLICY, "Custom");
  assert.equal(
    workflowFor({ approvalPolicy: DEFAULT_APPROVAL_POLICY, workflow: explicit })
      .name,
    "Custom",
  );
  assert.equal(
    workflowFor({ approvalPolicy: DEFAULT_APPROVAL_POLICY }).name,
    "Default approval workflow",
  );
});
