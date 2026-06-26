import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowStep } from "@/lib/approval-workflow";
import {
  deriveOutcome,
  isAwaitingApproval,
  pendingGates,
} from "@/lib/run-outcome";
import type { TraceEvent } from "@/lib/trace";

/**
 * Tests for the queue-pill outcome logic. This had a real bug: an `awaiting`
 * (paused) reconciliation also has `posted: false`, which a naive check
 * mistook for "blocked" (red) instead of "needs-approval" (amber). These pin the
 * outcome for each reconciliation result so the pill colour is right.
 */
const ev = (data: Record<string, unknown>): TraceEvent => {
  return {
    seq: 0,
    kind: "step",
    stage: "pipeline",
    status: "ok",
    stepId: "x",
    label: "",
    data,
    atMs: 0,
  };
};

const matching = (verdict: string) => ev({ verdict });
const approval = (
  outcome: string,
  steps: { id: string; status: string; detail: string }[] = [],
) => ev({ outcome, steps });
const recon = (outcome: string, posted: boolean) => ev({ outcome, posted });

test("clean → reconciled (posted)", () => {
  const trace = [matching("clean"), approval("auto"), recon("posted", true)];
  assert.equal(deriveOutcome(trace, true), "reconciled");
});

test("exception awaiting → needs-approval (NOT blocked, despite posted:false)", () => {
  const trace = [
    matching("exception"),
    approval("manager"),
    recon("awaiting", false),
  ];
  assert.equal(deriveOutcome(trace, true), "needs-approval");
  assert.equal(isAwaitingApproval(trace), true);
});

test("exception approved → reconciled", () => {
  const trace = [
    matching("exception"),
    approval("director"),
    recon("posted", true),
  ];
  assert.equal(deriveOutcome(trace, true), "reconciled");
  assert.equal(isAwaitingApproval(trace), false);
});

test("exception rejected → blocked (red)", () => {
  const trace = [
    matching("exception"),
    approval("manager"),
    recon("rejected", false),
  ];
  assert.equal(deriveOutcome(trace, true), "blocked");
});

test("duplicate → blocked", () => {
  const trace = [
    matching("duplicate"),
    approval("blocked"),
    recon("blocked", false),
  ];
  assert.equal(deriveOutcome(trace, true), "blocked");
});

test("mid-stream: an awaiting approval node reads as needs-approval before recon", () => {
  // The approval node now carries the workflow outcome directly, so an awaiting
  // gate signals needs-approval as soon as it streams in (before reconciliation).
  const trace = [
    matching("exception"),
    approval("awaiting", [
      { id: "manager-review", status: "pending", detail: "Awaiting Manager." },
    ]),
  ];
  assert.equal(deriveOutcome(trace, false), "needs-approval");
  assert.equal(isAwaitingApproval(trace), true); // the gate is pending
});

test("running with no recognizable data yet → running", () => {
  assert.equal(deriveOutcome([], false), "running");
});

/* ── pendingGates ──────────────────────────────────────────────────────────── */

const gate = (id: string, approverName: string | null): WorkflowStep => ({
  id,
  kind: "approval",
  label: `${id} review`,
  when: { kind: "always" },
  approverTitle: "Manager",
  approverName,
  next: [],
});
const post = (id: string): WorkflowStep => ({
  id,
  kind: "integration",
  label: "Post the bill",
  when: { kind: "always" },
  integration: "netsuite",
  next: [],
});

test("pendingGates: two pending gates → two rows in workflow order", () => {
  const steps = [
    gate("manager-review", "Esther Howard"),
    gate("department-review", "Sam Patel"),
  ];
  const rows = pendingGates(
    { "manager-review": "pending", "department-review": "pending" },
    steps,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["manager-review", "department-review"],
  );
  assert.equal(rows[0]?.approverName, "Esther Howard");
});

test("pendingGates: a settled gate is excluded", () => {
  const steps = [
    gate("manager-review", "Esther Howard"),
    gate("department-review", "Sam Patel"),
  ];
  const rows = pendingGates(
    { "manager-review": "approved", "department-review": "pending" },
    steps,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["department-review"],
  );
});

test("pendingGates: a pending integration step is never a gate", () => {
  const steps = [gate("manager-review", "Esther Howard"), post("post")];
  const rows = pendingGates(
    { "manager-review": "pending", post: "pending" },
    steps,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["manager-review"],
  );
});

test("pendingGates: nothing pending → empty", () => {
  const steps = [gate("manager-review", "Esther Howard")];
  assert.deepEqual(pendingGates({ "manager-review": "approved" }, steps), []);
  assert.deepEqual(pendingGates({}, steps), []);
});
