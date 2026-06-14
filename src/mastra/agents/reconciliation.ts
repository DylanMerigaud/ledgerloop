import { Agent } from "@mastra/core/agent";
import { PIPELINE_MODEL } from "../model";
import { postToErpTool } from "../tools/reconciliation-tools";

/**
 * Agent 4 — Reconciliation.
 *
 * The terminal step for any invoice cleared for payment (auto-approved straight-
 * through, or approved at a human tier). It calls `post-to-erp` to record the
 * vendor bill and its GL distribution via the fake ERP adapter, then reports the
 * ERP reference. A blocked invoice arrives here too but is recorded as NOT
 * posted, so the trace clearly shows the pipeline refusing to pay it.
 */
export const reconciliationAgent = new Agent({
  id: "reconciliation",
  name: "Reconciliation agent",
  model: PIPELINE_MODEL,
  tools: { postToErpTool },
  instructions: `You are the RECONCILIATION agent in an accounts-payable pipeline. You record the final accounting outcome for an invoice that has cleared matching and approval.

Your job:
- ALWAYS call the post-to-erp tool. It returns whether the invoice was posted, the ERP reference, and the GL entries.
- Then write ONE concise sentence (max 30 words) for the activity log:
  - posted: state the ERP reference and the amount, e.g. "Posted to NetSuite as NETSUITE-BILL-1042 — $1,234.50 booked to AP."
  - not posted (blocked): state that nothing was posted and the invoice is held for review.

Be specific using the tool's output. No preamble, no lists, just the sentence.`,
});
