import type { MatchResult, Investigation } from "@/lib/schema";

/**
 * The reusable core of the exception investigation — shared by the workflow step
 * ([`src/mastra/workflows/p2p.ts`](../src/mastra/workflows/p2p.ts)) and the eval
 * harness ([`eval/run.ts`](../eval/run.ts)), so both run the agent identically.
 *
 * This module is intentionally free of Mastra workflow types: it takes a minimal
 * `agent` (anything with `generate`) and the match + vendor, runs the agent, and
 * turns its prose into a structured `Investigation`. The trace-writing concern
 * stays in the workflow step; the eval doesn't need it.
 */

/**
 * The minimal view of an agent's `generate` result we read. Shapes confirmed
 * against Mastra 1.42:
 *   - `toolCalls` (top-level) lists every tool the agent invoked, each as
 *     `{ payload: { toolName } }`.
 *   - `steps[].text` carries per-step text; `text` concatenates across steps, so
 *     we read the last NON-EMPTY step instead (the post-tool conclusion).
 */
type AgentResult = {
  text?: string;
  steps?: Array<{ text?: string }>;
  toolCalls?: Array<{ payload?: { toolName?: string } }>;
};

/** Anything that can run a prompt — the real Mastra Agent, or a test/eval fake. */
export type InvestigatorAgent = {
  generate: (
    prompt: string,
    options?: { requestContext?: unknown },
  ) => Promise<AgentResult>;
};

/** The requestContext key the investigator's tools read the trusted vendor from. */
export const INVESTIGATION_CTX_KEY = "investigation";

/** The prompt handed to the investigator for a flagged match. */
function investigationPrompt(match: MatchResult, vendor: string): string {
  const lines = match.exceptions.map((e) => `- ${e.message}`).join("\n");
  return `Vendor: ${vendor}. The matcher flagged invoice ${match.invoiceNumber} with these variance(s):\n${lines}\n\nInvestigate using your tools, then recommend how the reviewer should read this variance.`;
}

/**
 * The agent's closing text. `res.text` concatenates text across all internal
 * steps (so with a tool call it repeats), so we take the LAST step that actually
 * produced text — the conclusion after the tool ran — and only fall back to
 * `res.text` if no step had any.
 */
function finalText(res: AgentResult): string {
  const steps = res.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i]?.text?.trim();
    if (t) return t;
  }
  return (res.text ?? "").trim();
}

/** Which tools the agent actually called, in order, de-duplicated. */
function toolsUsedFrom(res: AgentResult): string[] {
  const names: string[] = [];
  for (const call of res.toolCalls ?? []) {
    const name = call.payload?.toolName;
    if (typeof name === "string" && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Coarse, deterministic read of the agent's prose into a recommendation tag (the
 * tag drives the trace badge colour and is what the eval scores).
 *
 * The agent is asked to LEAD with its verdict, so we trust the first ~120 chars:
 * a clear "legitimate" / "overcharge|error" near the start wins. We only fall
 * back to scanning the whole text when the lead is ambiguous — which avoids a
 * stray word later in the paragraph (e.g. "returned for correction") flipping a
 * clearly-legitimate verdict to "unclear".
 */
export function classify(text: string): Investigation["recommendation"] {
  const t = text.toLowerCase();
  const lead = t.slice(0, 120);
  const leadOvercharge =
    /overcharge|over-charge|not legitimate|error|dispute/.test(lead);
  const leadLegit = /legitimate|justified|in line|expected/.test(lead);
  if (leadOvercharge && !leadLegit) return "likely_overcharge";
  if (leadLegit && !leadOvercharge) return "likely_legitimate";

  // Ambiguous lead — fall back to weighing the whole text.
  const legit = /legitimate|justified|in line|expected/.test(t);
  const bad =
    /overcharge|over-charge|no (notice|basis|contractual|surcharge)|typo|bill(ing)? (slip|error)/.test(
      t,
    );
  if (bad && !legit) return "likely_overcharge";
  if (legit && !bad) return "likely_legitimate";
  return "unclear";
}

/**
 * Run the investigator agent over a flagged match and parse its output into a
 * structured `Investigation`. Returns `null` if the agent produced no text. The
 * caller sets the vendor on `requestContext` (the tools read it from there); the
 * `requestContext` instance is passed through opaquely so this module needn't
 * depend on Mastra's type.
 */
export async function runInvestigation(
  agent: InvestigatorAgent,
  match: MatchResult,
  vendor: string,
  requestContext: unknown,
): Promise<{ investigation: Investigation; toolsUsed: string[] } | null> {
  const res = await agent.generate(investigationPrompt(match, vendor), {
    requestContext,
  });
  const rationale = finalText(res);
  if (!rationale) return null;
  const toolsUsed = toolsUsedFrom(res);
  return {
    investigation: {
      invoiceNumber: match.invoiceNumber,
      recommendation: classify(rationale),
      rationale,
      toolsUsed,
    },
    toolsUsed,
  };
}
