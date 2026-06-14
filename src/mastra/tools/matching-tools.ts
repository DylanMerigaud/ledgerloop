import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { MatchResult } from "@/lib/schema";
import { runMatch } from "@/lib/matching";
import { CTX, type ToolContext } from "./context";

/**
 * Tool for the Matching agent.
 *
 * The agent genuinely CALLS this tool (it shows as a `tool-call` in the trace),
 * but the tool doesn't trust the model to pass the documents — it reads the
 * server-side document bundle from `requestContext` (injected by the workflow
 * step) and runs the pure, unit-tested `runMatch`. So the call is real and
 * agentic, while the verdict that drives the routing stays deterministic and the
 * demo's edge cases fire reliably.
 *
 * The tool takes no model-supplied arguments (empty input schema) — calling it
 * is the signal; the data comes from context.
 */
export const runMatchTool = createTool({
  id: "run-match",
  description:
    "Run the 2-way / 3-way procure-to-pay match for the invoice currently under review. Takes no arguments — call it to compute the authoritative verdict (clean | exception | duplicate), the line-level exceptions, and the money at stake.",
  inputSchema: z.object({}),
  outputSchema: MatchResult,
  execute: async (_input, context) => {
    const input = context?.requestContext?.get(CTX.matchInput) as
      | ToolContext["matchInput"]
      | undefined;
    if (!input) {
      throw new Error("run-match: no match input in request context");
    }
    return runMatch(input);
  },
});
