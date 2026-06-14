import { Mastra } from "@mastra/core";
import { intakeAgent } from "./agents/intake";
import { matchingAgent } from "./agents/matching";
import { approvalAgent } from "./agents/approval";
import { reconciliationAgent } from "./agents/reconciliation";
import { p2pWorkflow } from "./workflows/p2p";

/**
 * The central Mastra instance — the registry that wires the four agents and the
 * procure-to-pay workflow together. The workflow steps look agents up by id
 * (`mastra.getAgent("matching")`, …), so they must be registered here under the
 * same ids the steps use.
 *
 * Telemetry is left at its defaults; this is a stateless demo with no persistent
 * Mastra storage (the pipeline streams its trace to the browser and forgets —
 * see the run route). One instance is created and shared per server runtime.
 */
export const mastra = new Mastra({
  agents: {
    intake: intakeAgent,
    matching: matchingAgent,
    approval: approvalAgent,
    reconciliation: reconciliationAgent,
  },
  workflows: {
    p2p: p2pWorkflow,
  },
});
