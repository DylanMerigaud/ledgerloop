import { RequestContext } from "@mastra/core/request-context";
import type { z } from "zod";

/**
 * The shared "real agent step" runner — the pattern that makes the agents
 * genuinely agentic while keeping the pipeline reliable.
 *
 * For a stage, the deterministic, unit-tested function is ALWAYS the source of
 * truth for the result that routes the workflow. On top of that, we let the
 * agent actually work:
 *   1. inject the trusted, server-side input into the agent's `requestContext`
 *      (so its tool reads the real documents, not model-hallucinated args),
 *   2. ask the agent to call its tool and narrate the result,
 *   3. the tool runs the SAME pure function and returns its output, which the
 *      agent then describes.
 *
 * So a real `tool-call` fires (visible in the trace) and the agent produces the
 * narration — but correctness never depends on parsing the model's response.
 * Whatever the model does, `data` is the deterministic value; if the call throws
 * (no API key, rate limit) or the model stays silent, we simply use a
 * deterministic fallback narration. Agents narrate and invoke; rules decide.
 */

interface AgentLike {
  generate: (
    prompt: string,
    options?: { requestContext?: RequestContext },
  ) => Promise<{ text?: string }>;
}

interface MastraLike {
  getAgent: (id: string) => AgentLike | undefined;
}

export interface AgentStepResult<T> {
  /** The deterministic stage result that drives routing. */
  data: T;
  /** The agent's one-line narration (or a deterministic fallback). */
  narration: string;
}

export interface RunAgentStepArgs<TSchema extends z.ZodTypeAny> {
  mastra: MastraLike | undefined;
  agentId: string;
  /** The tool the agent is expected to call (it reads its input from context). */
  toolName: string;
  /** Values exposed to the tool via requestContext (keyed by the tool's CTX keys). */
  context: Record<string, unknown>;
  /** The prompt asking the agent to call the tool and narrate. */
  prompt: string;
  /** The deterministic, authoritative result for this stage. */
  result: z.infer<TSchema>;
  /** Deterministic one-liner used if the agent produced no narration. */
  fallbackNarration: (data: z.infer<TSchema>) => string;
}

export async function runAgentStep<TSchema extends z.ZodTypeAny>(
  args: RunAgentStepArgs<TSchema>,
): Promise<AgentStepResult<z.infer<TSchema>>> {
  const { mastra, agentId, context, prompt, result, fallbackNarration } = args;
  void args.toolName; // documented intent; the tool reads its input from context

  // The deterministic result always wins — the agent call below only adds the
  // real tool-call event + a human narration on top of it.
  try {
    const agent = mastra?.getAgent(agentId);
    if (!agent) return { data: result, narration: fallbackNarration(result) };

    const requestContext = new RequestContext();
    for (const [key, value] of Object.entries(context)) {
      requestContext.set(key, value);
    }
    const res = await agent.generate(prompt, { requestContext });
    const narration = (res.text ?? "").trim();
    return {
      data: result,
      narration: narration.length > 0 ? narration : fallbackNarration(result),
    };
  } catch {
    // No key / rate limit / network — the deterministic result + line still stand.
    return { data: result, narration: fallbackNarration(result) };
  }
}
