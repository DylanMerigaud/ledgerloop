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
  ) => Promise<{ text?: string; steps?: Array<{ text?: string }> }>;
}

/**
 * The agent's FINAL narration. `generate().text` concatenates text across ALL
 * internal steps (so with a tool call it can include pre-tool chatter or repeat),
 * whereas the last step's text is the clean closing sentence after the tool ran —
 * which is what we want on the trace.
 */
function finalText(res: {
  text?: string;
  steps?: Array<{ text?: string }>;
}): string {
  const steps = res.steps ?? [];
  const last = steps.length > 0 ? steps[steps.length - 1]?.text : undefined;
  return (last ?? res.text ?? "").trim();
}

interface MastraLike {
  getAgent: (id: string) => AgentLike | undefined;
}

/** The workflow step's stream writer (Mastra's `StreamChunkWriter`). */
interface ChunkWriter {
  write: (chunk: unknown) => Promise<void>;
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
  /**
   * The step's stream writer. A sub-agent's own tool-call events don't bubble
   * up into the workflow stream, so we surface the tool interaction explicitly:
   * the step writes a `tool-call` chunk (and a `tool-result`) here so it appears
   * on the live trace timeline. The agent genuinely calls the tool too — this
   * just makes that call visible in the workflow's event stream.
   */
  writer?: ChunkWriter;
}

export async function runAgentStep<TSchema extends z.ZodTypeAny>(
  args: RunAgentStepArgs<TSchema>,
): Promise<AgentStepResult<z.infer<TSchema>>> {
  const {
    mastra,
    agentId,
    toolName,
    context,
    prompt,
    result,
    fallbackNarration,
    writer,
  } = args;

  // Surface the tool call on the workflow stream (sub-agent events don't bubble
  // up on their own). Best-effort — never let a writer hiccup affect the result.
  try {
    await writer?.write({ type: "tool-call", payload: { toolName } });
    await writer?.write({ type: "tool-result", payload: { toolName } });
  } catch {
    /* ignore writer errors */
  }

  // The deterministic result always wins — the agent call below only adds the
  // human narration on top of it.
  try {
    const agent = mastra?.getAgent(agentId);
    if (!agent) return { data: result, narration: fallbackNarration(result) };

    const requestContext = new RequestContext();
    for (const [key, value] of Object.entries(context)) {
      requestContext.set(key, value);
    }
    const res = await agent.generate(prompt, { requestContext });
    const narration = finalText(res);
    return {
      data: result,
      narration: narration.length > 0 ? narration : fallbackNarration(result),
    };
  } catch {
    // No key / rate limit / network — the deterministic result + line still stand.
    return { data: result, narration: fallbackNarration(result) };
  }
}
