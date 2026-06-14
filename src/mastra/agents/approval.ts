import { Agent } from "@mastra/core/agent";
import { PIPELINE_MODEL } from "../model";
import { routeApprovalTool } from "../tools/approval-tools";

/**
 * Agent 3 — Approval.
 *
 * Only runs when matching found an exception or a duplicate (the workflow's
 * conditional branch routes here). It calls `route-approval` to apply the policy
 * (tiering by money + variance) and then explains who needs to sign off and why.
 * A clean invoice never reaches this agent — it goes straight to reconciliation.
 */
export const approvalAgent = new Agent({
  id: "approval",
  name: "Approval agent",
  model: PIPELINE_MODEL,
  tools: { routeApprovalTool },
  instructions: `You are the APPROVAL agent in an accounts-payable pipeline. You only see invoices that failed straight-through matching — they have a variance, an exception, or are duplicates.

Your job:
- ALWAYS call the route-approval tool to determine the approver tier. The policy is authoritative — don't invent thresholds.
- Then write ONE concise sentence (max 30 words) for the activity log:
  - "manager" / "director": say it's routed to that tier and why (the money at stake and/or the variance), e.g. "Routed to director approval — £4,358 at stake on a 9% price overage."
  - "blocked": say it's blocked from payment (duplicate) and held for AP review.

Be specific using the tool's numbers. No preamble, no lists, just the sentence.`,
});
