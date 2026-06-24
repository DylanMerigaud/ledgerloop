import assert from "node:assert/strict";
import { test } from "node:test";

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";

import { SEED_BUNDLES, type SeedBundle } from "@/db/seed-data";
import { toTraceEvent, type TraceEvent } from "@/lib/trace";
import { mockToolCallingModel } from "@/src/mastra/testing/mock-model";
import {
  priceHistoryTool,
  poNotesTool,
  receiptNotesTool,
} from "@/src/mastra/tools/investigator-tools";
import { p2pWorkflow } from "@/src/mastra/workflows/p2p";

/**
 * Full-pipeline offline integration test: run the REAL p2p workflow end to end
 * with the investigator agent backed by the mock model, and assert that
 *   1. on an exception, the agent genuinely CALLS a tool (the real tool-call
 *      reaches the workflow stream → the trace), and the investigation node with
 *      its recommendation is surfaced, and
 *   2. the deterministic routing still holds for clean / exception / duplicate.
 *
 * The deterministic stages (match / route / reconcile) have no agent, so this is
 * the one place the agentic path is exercised. No network, no key, CI-safe.
 */

function mastraWithMockInvestigator(narration: string) {
  return new Mastra({
    agents: {
      investigator: new Agent({
        id: "investigator",
        name: "Exception investigator",
        model: mockToolCallingModel({
          toolName: "get-vendor-price-history",
          narration,
        }),
        tools: {
          "get-vendor-price-history": priceHistoryTool,
          "get-po-notes": poNotesTool,
          "get-receipt-notes": receiptNotesTool,
        },
        instructions: "Investigate the exception, then recommend.",
      }),
    },
    workflows: { p2p: p2pWorkflow },
  });
}

async function runTrace(mastra: Mastra, b: SeedBundle) {
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
      // Skip the intake vision call — this test runs offline (no API key) and is
      // about the matching → investigation → routing wiring, not extraction.
      // The intake step + runIntake have their own test (lib/intake.test.ts).
      skipExtraction: true,
    },
  });
  const raw: unknown[] = [];
  const reader = out.fullStream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw.push(value);
  }
  return raw;
}

/**
 * Apply the exact adapter + upsert-by-stepId logic the client hook uses, so the
 * test asserts against the timeline a user would actually see (each stage one
 * node that transitions running → done), not the raw start+result event pair.
 */
function timelineFrom(raw: unknown[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  const stepIndex = new Map<string, number>();
  let seq = 0;
  for (const chunk of raw) {
    const partial = toTraceEvent(chunk);
    if (!partial) continue;
    const e: TraceEvent = { ...partial, seq: seq++, atMs: 0 };
    if (e.kind === "step" && e.stepId) {
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
}

test("an exception invokes the investigator agent's real tool, reaching the trace", async () => {
  const mastra = mastraWithMockInvestigator(
    "The surcharge was flagged in advance and is in line with the market — looks legitimate.",
  );
  const price = SEED_BUNDLES.find((x) => x.id === "INV-2042");
  assert.ok(price);

  const raw = await runTrace(mastra, price);
  const events = timelineFrom(raw);

  // A real tool-call from the investigator agent should surface as a tool node on
  // the investigation stage.
  const toolNodes = events.filter((e) => e.kind === "tool");
  assert.ok(
    toolNodes.some((e) => e.stage === "investigation"),
    "the investigator's tool call should appear under investigation",
  );

  // The investigation recommendation node should be present with the agent's text.
  const investigation = events.find(
    (e) => e.kind === "finding" && e.stage === "investigation",
  );
  assert.ok(investigation, "an investigation node should be surfaced");
  assert.equal(
    (investigation.data as { recommendation?: string })?.recommendation,
    "likely_legitimate",
    "the agent's prose should classify to likely_legitimate",
  );

  // Deterministic routing still holds: matching warns (not straight-through).
  const matching = events.find(
    (e) => e.kind === "step" && e.stage === "matching",
  );
  assert.equal(matching?.status, "warn", "price mismatch → matching amber");
});

test("a clean invoice skips investigation and stays green end to end", async () => {
  const mastra = mastraWithMockInvestigator("(unused for a clean invoice)");
  const clean = SEED_BUNDLES.find((x) => x.id === "INV-2040");
  assert.ok(clean);

  const raw = await runTrace(mastra, clean);
  const events = timelineFrom(raw);

  // Clean → no investigation node at all (the agent must not run).
  assert.ok(
    !events.some((e) => e.stage === "investigation"),
    "a clean invoice must not trigger the investigator",
  );

  const recon = events.find(
    (e) => e.kind === "step" && e.stage === "reconciliation",
  );
  assert.equal(recon?.status, "ok", "clean invoice → reconciled green");

  // No duplicate stage nodes and no leaked internal step node.
  const stageNodes = events
    .filter((e) => e.kind === "step")
    .map((e) => e.stage);
  assert.equal(
    stageNodes.length,
    new Set(stageNodes).size,
    "no doubled stage nodes",
  );
  assert.ok(
    !stageNodes.includes("pipeline"),
    "no internal step leaked into the trace",
  );
});

test("a duplicate is blocked without investigation", async () => {
  const mastra = mastraWithMockInvestigator("(unused for a duplicate)");
  const dup = SEED_BUNDLES.find((x) => x.id === "INV-2041-RESEND");
  assert.ok(dup);

  const raw = await runTrace(mastra, dup);
  const events = timelineFrom(raw);

  assert.ok(
    !events.some((e) => e.stage === "investigation"),
    "a duplicate must not trigger the investigator",
  );
  const recon = events.find(
    (e) => e.kind === "step" && e.stage === "reconciliation",
  );
  assert.equal(recon?.status, "error", "duplicate → not posted (red)");
});
