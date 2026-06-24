import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOutcome, isAwaitingApproval } from "./run-outcome";
import type { TraceEvent } from "./trace";

/**
 * Tests for the queue-pill outcome logic. This had a real bug: an `awaiting`
 * (paused) reconciliation also has `posted: false`, which a naive check
 * mistook for "blocked" (red) instead of "needs-approval" (amber). These pin the
 * outcome for each reconciliation result so the pill colour is right.
 */

// Minimal trace-event builder carrying a stage `data` payload.
function ev(data: Record<string, unknown>): TraceEvent {
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
}

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
