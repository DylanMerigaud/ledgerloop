import assert from "node:assert/strict";
import { test } from "node:test";

import { Mastra } from "@mastra/core";

import { SEED_BUNDLES, type SeedBundle } from "@/db/seed-data";
import { type ApprovalWorkflow } from "@/lib/approval-workflow";
import { isRecord } from "@/lib/assert";
import { type ClientProfile } from "@/lib/client-profile";
import { toTraceEvent, type TraceEvent } from "@/lib/trace";
import { p2pWorkflow } from "@/src/mastra/workflows/p2p";

/**
 * The link this branch adds: the workflow passed into a run is the one the
 * pipeline ROUTES through, not a fixed default. We prove it with a CLEAN invoice
 * — under the default DAG every gate's condition is false, so it posts
 * straight-through. Pass a workflow whose first gate is `when: always` and the
 * SAME clean invoice must instead PAUSE on that gate. Different workflow in →
 * different routing out, on identical invoice + matching.
 *
 * Runs the real p2p workflow offline (skipExtraction, no agent, no key) the same
 * way pipeline-trace.test.ts does, so it's deterministic and CI-safe.
 */

/** A minimal one-gate workflow: an always-on approval before the post. */
const ALWAYS_GATE: ApprovalWorkflow = {
  name: "Every bill needs a sign-off",
  roots: ["sign-off"],
  steps: [
    {
      id: "sign-off",
      kind: "approval",
      label: "Sign-off",
      when: { kind: "always" },
      approverTitle: "Controller",
      approverName: "Dana Lee",
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

/** Run the real p2p workflow for a seed bundle, optionally under a profile. */
const runTrace = async (
  b: SeedBundle,
  profile?: ClientProfile,
): Promise<TraceEvent[]> => {
  const mastra = new Mastra({ workflows: { p2p: p2pWorkflow } });
  const idx = SEED_BUNDLES.indexOf(b);
  const priorInvoiceNumbers = SEED_BUNDLES.slice(0, idx).map(
    (x) => x.invoice.invoiceNumber,
  );
  const run = await mastra.getWorkflow("p2p").createRun();
  const out = run.stream({
    inputData: {
      invoice: b.invoice,
      purchaseOrder: b.purchaseOrder ?? null,
      goodsReceipt: b.goodsReceipt ?? null,
      priorInvoiceNumbers,
      // Offline: skip the vision call (extraction has its own test). This is about
      // routing, which reads the matching verdict, not the document read.
      skipExtraction: true,
      profile,
    },
  });
  // Collapse by stepId exactly like the client hook does, so each stage is the
  // single node a user ends up seeing (running → final), not the start+result pair.
  const events: TraceEvent[] = [];
  const stepIndex = new Map<string, number>();
  let seq = 0;
  const reader = out.fullStream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const partial = toTraceEvent(value);
    if (!partial) continue;
    const e: TraceEvent = { ...partial, seq: seq++, atMs: 0 };
    if (e.stepId) {
      const existing = stepIndex.get(e.stepId);
      if (existing !== undefined) events[existing] = e;
      else {
        stepIndex.set(e.stepId, events.length);
        events.push(e);
      }
    } else {
      events.push(e);
    }
  }
  return events;
};

const approvalNode = (events: TraceEvent[]): TraceEvent | undefined =>
  events.find((e) => e.kind === "step" && e.stage === "approval");

const clean = (): SeedBundle => {
  const b = SEED_BUNDLES.find((x) => x.id === "INV-2040");
  assert.ok(b, "INV-2040 (clean 3-way) is seeded");
  return b;
};

test("a passed-in always-gate workflow pauses a CLEAN invoice that would otherwise auto-post", async () => {
  const profile: ClientProfile = {
    id: "active",
    name: ALWAYS_GATE.name,
    // Default tolerances — keep the verdict clean; only the workflow changes.
    tolerances: { pricePct: 0.01, lineAmountAbs: 0.01, qtyAbs: 0 },
    approvalPolicy: {
      manager: { amount: 1_000, variancePct: 0.05 },
      director: { amount: 10_000, variancePct: 0.1 },
    },
    workflow: ALWAYS_GATE,
  };

  const events = await runTrace(clean(), profile);
  const approval = approvalNode(events);
  assert.ok(approval, "the clean invoice runs the approval workflow");
  // The always-gate fires → the run is awaiting a human, not posted.
  assert.equal(
    approval.status,
    "waiting",
    "the always-on gate should pause the run",
  );
  assert.ok(isRecord(approval.data), "the approval node carries its summary");
  assert.equal(approval.data["outcome"], "awaiting");

  // Reconciliation must NOT have posted while a gate is pending.
  const recon = events.find(
    (e) => e.kind === "step" && e.stage === "reconciliation",
  );
  assert.notEqual(recon?.status, "ok", "nothing posts while a gate pends");
});

test("the same CLEAN invoice with no passed workflow posts straight through (default DAG)", async () => {
  // No profile at all → the pipeline falls back to its default workflow, under
  // which a clean invoice has no active gate and posts straight through.
  const events = await runTrace(clean());
  const approval = approvalNode(events);
  assert.ok(approval, "the clean invoice still runs the (default) workflow");
  assert.equal(
    approval.status,
    "ok",
    "no gate fires on a clean invoice under the default DAG",
  );
  assert.ok(isRecord(approval.data));
  assert.equal(approval.data["outcome"], "posted");

  const recon = events.find(
    (e) => e.kind === "step" && e.stage === "reconciliation",
  );
  assert.equal(recon?.status, "ok", "clean invoice reconciles green");
});
