import { test } from "node:test";
import assert from "node:assert/strict";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { mockToolCallingModel } from "./mock-model";
import { p2pWorkflow } from "../workflows/p2p";
import { runMatchTool } from "../tools/matching-tools";
import { routeApprovalTool } from "../tools/approval-tools";
import { postToErpTool } from "../tools/reconciliation-tools";
import { SEED_BUNDLES, type SeedBundle } from "@/db/seed-data";
import { toTraceEvent, type TraceEvent } from "@/lib/trace";

/**
 * Full-pipeline offline integration test: run the REAL p2p workflow end to end
 * with all four agents backed by the mock model, and assert that real tool-call
 * events reach the workflow's stream (and thus the trace). This is the offline
 * proof of the README's claim that the agents genuinely call their tools — the
 * one thing the no-key runtime audit couldn't show. No network, CI-safe.
 *
 * The agents are registered under the same ids the workflow steps look up
 * (`mastra.getAgent("matching")` etc.), each with its real tool + the mock
 * model, so the steps drive the actual agentic path, not the fallback.
 */

function mockAgent(
  id: string,
  name: string,
  tools: ConstructorParameters<typeof Agent>[0]["tools"],
  toolName: string,
) {
  return new Agent({
    id,
    name,
    model: mockToolCallingModel({ toolName, narration: `${name} done.` }),
    tools,
    instructions: `Call ${toolName}, then summarise in one sentence.`,
  });
}

function mastraWithMockAgents() {
  return new Mastra({
    agents: {
      intake: new Agent({
        id: "intake",
        name: "Intake agent",
        model: mockToolCallingModel({
          toolName: "noop",
          narration: "Received.",
        }),
        instructions: "Summarise the invoice in one sentence.",
      }),
      matching: mockAgent(
        "matching",
        "Matching agent",
        { runMatchTool },
        "run-match",
      ),
      approval: mockAgent(
        "approval",
        "Approval agent",
        { routeApprovalTool },
        "route-approval",
      ),
      reconciliation: mockAgent(
        "reconciliation",
        "Reconciliation agent",
        { postToErpTool },
        "post-to-erp",
      ),
    },
    workflows: { p2p: p2pWorkflow },
  });
}

async function runTrace(
  mastra: ReturnType<typeof mastraWithMockAgents>,
  b: SeedBundle,
) {
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

test("the price-mismatch invoice fires real tool calls that reach the trace", async () => {
  const mastra = mastraWithMockAgents();
  const price = SEED_BUNDLES.find((x) => x.id === "INV-2042");
  assert.ok(price);

  const raw = await runTrace(mastra, price);

  // The steps write tool-call chunks to the workflow stream when their agents
  // invoke their tools; Mastra delivers them wrapped in `workflow-step-output`.
  const toolOutputs = raw.filter((c) => {
    const v = c as { type?: string; payload?: { output?: { type?: string } } };
    return (
      v.type === "workflow-step-output" &&
      v.payload?.output?.type === "tool-call"
    );
  });
  assert.ok(
    toolOutputs.length > 0,
    "expected tool-call chunks in the workflow stream",
  );

  // And our adapter turns them into "tool" trace nodes on the right stages.
  const events = timelineFrom(raw);
  const toolNodes = events.filter((e) => e.kind === "tool");
  const toolStages = new Set(toolNodes.map((e) => e.stage));
  assert.ok(
    toolNodes.length > 0,
    "adapter should surface tool-call events as tool nodes",
  );
  assert.ok(
    toolStages.has("matching"),
    "the run-match tool call should appear under matching",
  );

  // The deterministic routing still holds: matching warns, no straight-through.
  const matching = events.find(
    (e) => e.kind === "step" && e.stage === "matching",
  );
  assert.equal(matching?.status, "warn", "price mismatch → matching amber");
});

test("a clean invoice fires tool calls and stays green end to end", async () => {
  const mastra = mastraWithMockAgents();
  const clean = SEED_BUNDLES.find((x) => x.id === "INV-2040");
  assert.ok(clean);

  const raw = await runTrace(mastra, clean);
  const events = timelineFrom(raw);

  const recon = events.find(
    (e) => e.kind === "step" && e.stage === "reconciliation",
  );
  assert.equal(recon?.status, "ok", "clean invoice → reconciled green");
  // No duplicate stage nodes and no leaked pipeline-step node.
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
