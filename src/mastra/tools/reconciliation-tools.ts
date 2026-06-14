import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { ReconResult } from "@/lib/schema";
import { reconcile } from "@/lib/erp";
import { CTX, type ToolContext } from "./context";

/**
 * Tool for the Reconciliation agent. The agent calls it (a real `tool-call` in
 * the trace); the tool reads the approval decision + match from `requestContext`
 * and posts the vendor bill through the fake ERP adapter (`lib/erp.ts`), or
 * refuses to post a blocked invoice. Deterministic result, real tool invocation.
 */
export const postToErpTool = createTool({
  id: "post-to-erp",
  description:
    "Reconcile the invoice currently under review: post it to the ERP as a vendor bill (returning the ERP reference and the balanced GL entries), or leave it un-posted if it's blocked. Takes no arguments — call it to record the accounting outcome.",
  inputSchema: z.object({}),
  outputSchema: ReconResult,
  execute: async (_input, context) => {
    const input = context?.requestContext?.get(CTX.reconInput) as
      | ToolContext["reconInput"]
      | undefined;
    if (!input) {
      throw new Error("post-to-erp: no reconciliation input in request context");
    }
    return reconcile(input.decision, input.match, input.vendor, input.humanApproval);
  },
});
