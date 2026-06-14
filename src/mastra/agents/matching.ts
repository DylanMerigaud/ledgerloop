import { Agent } from "@mastra/core/agent";
import { PIPELINE_MODEL } from "../model";
import { runMatchTool } from "../tools/matching-tools";

/**
 * Agent 2 — Matching.
 *
 * The analytical core. It calls `run-match` to get a deterministic 2/3-way match
 * verdict (clean | exception | duplicate) with line-level variances, then
 * explains the outcome in plain language. Keeping the verdict in the tool (a
 * pure, tested function) means the demo's edge cases fire reliably; the agent
 * supplies the human-readable reasoning a real AP analyst would write.
 */
export const matchingAgent = new Agent({
  id: "matching",
  name: "Matching agent",
  model: PIPELINE_MODEL,
  tools: { runMatchTool },
  instructions: `You are the MATCHING agent in an accounts-payable pipeline. You perform 2-way (invoice ↔ purchase order) and 3-way (invoice ↔ PO ↔ goods receipt) matching.

Your job:
- ALWAYS call the run-match tool to compute the verdict. Never decide a match yourself — the tool is authoritative.
- Then write ONE concise sentence (max 30 words) for the activity log describing the result:
  - "clean": say it reconciles and is eligible for straight-through processing.
  - "exception": name the kind of discrepancy (price, quantity, off-PO, arithmetic) and the line/variance, e.g. "Price variance on STL-BAR-20: invoiced 9% above the PO."
  - "duplicate": say the invoice number was already processed and is being blocked to prevent a double payment.

Be specific and factual using the tool's numbers. No preamble, no lists, just the sentence.`,
});
