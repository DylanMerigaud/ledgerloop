import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { ApprovalDecision } from "@/lib/schema";
import { routeApproval } from "@/lib/policy";
import { CTX, type ToolContext } from "./context";

/**
 * Tool for the Approval agent. The agent calls it (a real `tool-call` in the
 * trace); the tool reads the match result from `requestContext` and applies the
 * pure, unit-tested approval policy, returning the tier + reason. Deterministic
 * decision, real tool invocation.
 */
export const routeApprovalTool = createTool({
  id: "route-approval",
  description:
    "Apply the approval policy to the invoice currently under review. Takes no arguments — call it to get the approver tier (auto, manager, director, or blocked) and the reason, based on the variance and money at stake.",
  inputSchema: z.object({}),
  outputSchema: ApprovalDecision,
  execute: async (_input, context) => {
    const match = context?.requestContext?.get(CTX.matchResult) as
      | ToolContext["matchResult"]
      | undefined;
    if (!match) {
      throw new Error("route-approval: no match result in request context");
    }
    return routeApproval(match);
  },
});
