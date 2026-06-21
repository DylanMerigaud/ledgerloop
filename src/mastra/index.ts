import { Mastra } from "@mastra/core";
import { investigatorAgent } from "./agents/investigator";
import { p2pWorkflow } from "./workflows/p2p";

/**
 * The central Mastra instance — registers the procure-to-pay workflow and the one
 * agent it uses.
 *
 * Most of the pipeline is deterministic code (matching, approval tiering,
 * reconciliation are pure functions — payment outcomes must be exact, not a
 * model's guess). The single agent is the EXCEPTION INVESTIGATOR: on the
 * exception branch the workflow looks it up by id (`mastra.getAgent("investigator")`)
 * to read messy vendor records and recommend how to read a flagged variance. It
 * must be registered here under that id.
 *
 * Telemetry is left at its defaults; this is a stateless demo with no persistent
 * Mastra storage (the pipeline streams its trace to the browser and forgets —
 * see the run route). One instance is created and shared per server runtime.
 */
export const mastra = new Mastra({
  agents: {
    investigator: investigatorAgent,
  },
  workflows: {
    p2p: p2pWorkflow,
  },
});
