import { test } from "node:test";
import assert from "node:assert/strict";
import { toTraceEvent, stageForStep, pipelineErrorEvent, TraceEvent } from "./trace";

/**
 * Tests for the Mastra-chunk → TraceEvent adapter. The two properties that
 * matter for a live demo: (1) the adapter never throws on junk input, and
 * (2) it maps each stage output to the right traffic-light status, since that's
 * what colors the "caught a mismatch" step red/amber on screen.
 */

test("stageForStep maps step ids to stages", () => {
  assert.equal(stageForStep("intake"), "intake");
  assert.equal(stageForStep("matching"), "matching");
  assert.equal(stageForStep("approval"), "approval");
  assert.equal(stageForStep("reconciliation"), "reconciliation");
  assert.equal(stageForStep("recon-post"), "reconciliation");
  assert.equal(stageForStep("something-else"), "pipeline");
});

test("workflow-start → running run event", () => {
  const e = toTraceEvent({ type: "workflow-start", payload: {} });
  assert.ok(e);
  assert.equal(e.kind, "run");
  assert.equal(e.status, "running");
});

test("step-start → running step event on the right stage", () => {
  const e = toTraceEvent({ type: "workflow-step-start", payload: { id: "matching" } });
  assert.ok(e);
  assert.equal(e.stage, "matching");
  assert.equal(e.status, "running");
});

test("exception MatchResult output → warn status", () => {
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: { id: "matching", output: { verdict: "exception" } },
  });
  assert.ok(e);
  assert.equal(e.status, "warn");
});

test("duplicate MatchResult output → error status", () => {
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: { id: "matching", output: { verdict: "duplicate" } },
  });
  assert.ok(e);
  assert.equal(e.status, "error");
});

test("blocked ApprovalDecision → error status", () => {
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: { id: "approval", output: { tier: "blocked" } },
  });
  assert.ok(e);
  assert.equal(e.status, "error");
});

test("auto ApprovalDecision → ok status", () => {
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: { id: "approval", output: { tier: "auto" } },
  });
  assert.ok(e);
  assert.equal(e.status, "ok");
});

test("un-posted ReconResult → error status", () => {
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: { id: "reconciliation", output: { posted: false } },
  });
  assert.ok(e);
  assert.equal(e.status, "error");
});

test("narration in output becomes the detail line", () => {
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: { id: "matching", output: { verdict: "clean", narration: "All lines reconcile." } },
  });
  assert.ok(e);
  assert.equal(e.detail, "All lines reconcile.");
});

test("unknown chunk types are dropped (null), not surfaced", () => {
  assert.equal(toTraceEvent({ type: "workflow-step-progress", payload: {} }), null);
  assert.equal(toTraceEvent({ type: "reasoning", payload: {} }), null);
});

test("malformed / junk input never throws → null", () => {
  assert.equal(toTraceEvent(undefined), null);
  assert.equal(toTraceEvent(null), null);
  assert.equal(toTraceEvent(42), null);
  assert.equal(toTraceEvent({ nope: true }), null);
  assert.equal(toTraceEvent({ type: 123 }), null);
});

test("a fully-stamped trace event validates against the Zod schema", () => {
  const partial = toTraceEvent({ type: "workflow-start", payload: {} });
  assert.ok(partial);
  const full = { ...partial, seq: 0, atMs: 0 };
  assert.doesNotThrow(() => TraceEvent.parse(full));
});

test("pipelineErrorEvent is a red finding", () => {
  const e = pipelineErrorEvent("boom", "matching");
  assert.equal(e.kind, "finding");
  assert.equal(e.status, "error");
  assert.equal(e.stage, "matching");
  assert.equal(e.detail, "boom");
});

test("the auto-approval step maps to the Approval stage", () => {
  assert.equal(stageForStep("approval-auto"), "approval");
});

test("tool-call events render at the right stage (mapped by tool name, not dropped)", () => {
  // Tool-call chunks carry a tool name but no workflow step id — they must NOT be
  // dropped, and should land under their agent's stage.
  const m = toTraceEvent({ type: "tool-call", payload: { toolName: "run-match" } });
  assert.ok(m, "tool-call must not be dropped");
  assert.equal(m.kind, "tool");
  assert.equal(m.stage, "matching");
  assert.match(m.label, /run-match/);

  const a = toTraceEvent({ type: "tool-call", payload: { toolName: "route-approval" } });
  assert.equal(a?.stage, "approval");
  const r = toTraceEvent({ type: "tool-call", payload: { toolName: "post-to-erp" } });
  assert.equal(r?.stage, "reconciliation");
});

test("the internal .map() step is dropped, not surfaced", () => {
  // Mastra inserts a `mapping_<uuid>` normalisation step between the branch and
  // reconciliation — it's plumbing and must not appear on the timeline.
  assert.equal(
    toTraceEvent({ type: "workflow-step-start", payload: { id: "mapping_abc-123" } }),
    null,
  );
  assert.equal(
    toTraceEvent({
      type: "workflow-step-result",
      payload: { id: "mapping_abc-123", output: { decision: {}, match: {}, vendor: "x" } },
    }),
    null,
  );
});

test("step events carry their stepId (so the UI can collapse start+result)", () => {
  const start = toTraceEvent({ type: "workflow-step-start", payload: { id: "matching" } });
  const result = toTraceEvent({
    type: "workflow-step-result",
    payload: { id: "matching", output: { verdict: "clean" } },
  });
  assert.equal(start?.stepId, "matching");
  assert.equal(result?.stepId, "matching");
  // same stepId on both → the hook upserts them into one node
  assert.equal(start?.stepId, result?.stepId);
});

test("run-level events have an empty stepId", () => {
  const e = toTraceEvent({ type: "workflow-start", payload: {} });
  assert.equal(e?.stepId, "");
});

test("approval step output is unwrapped: nested decision drives status + data", () => {
  // The approval step emits { decision, match, vendor, narration } — the status
  // and the rich-render `data` must come from the nested ApprovalDecision, not
  // the wrapper (regression guard for the nesting bug found by the runtime probe).
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: {
      id: "approval",
      output: {
        decision: { tier: "manager", autoApproved: false, reason: "Routed to manager." },
        match: { verdict: "exception" },
        vendor: "Severn Steelworks",
        narration: "Needs manager sign-off.",
      },
    },
  });
  assert.ok(e);
  assert.equal(e.status, "warn", "manager tier → amber");
  const data = e.data as Record<string, unknown>;
  assert.equal(data["tier"], "manager", "data is the unwrapped decision");
  assert.equal(e.detail, "Needs manager sign-off.");
});

test("blocked approval (nested) → error status", () => {
  const e = toTraceEvent({
    type: "workflow-step-result",
    payload: {
      id: "approval",
      output: { decision: { tier: "blocked", autoApproved: false, reason: "Duplicate." }, vendor: "x" },
    },
  });
  assert.equal(e?.status, "error");
});
