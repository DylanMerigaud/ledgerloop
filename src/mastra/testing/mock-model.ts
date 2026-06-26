import type { LanguageModel } from "@mastra/core/llm";

/**
 * A tiny in-process mock language model for tests — Mastra's own shipped mock
 * (`@mastra/core/test-utils/llm-mock`) is referenced in its package exports but
 * the file isn't published, so we hand-roll the minimum of the AI SDK v5 model
 * interface we need. Typed as Mastra's own `LanguageModel`, so whatever it
 * accepts, this satisfies.
 *
 * It always emits ONE tool call (to `toolName`, with `toolArgs` as the JSON
 * input) followed by a fixed `narration` text, then finishes — exactly the
 * sequence an agent step expects: the tool fires (proving the requestContext →
 * tool wiring and that the call reaches the trace), and the narration comes back
 * on `.text`. No network, no key, deterministic.
 */
export const mockToolCallingModel = (opts: {
  toolName: string;
  toolArgs?: unknown;
  narration: string;
  modelId?: string;
}): LanguageModel => {
  const {
    toolName,
    toolArgs = {},
    narration,
    modelId = "mock/tool-caller",
  } = opts;
  const input = JSON.stringify(toolArgs);
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  const model = {
    specificationVersion: "v2" as const,
    provider: "mock",
    modelId,
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [
          { type: "tool-call" as const, toolCallId: "call_1", toolName, input },
          { type: "text" as const, text: narration },
        ],
        finishReason: "tool-calls" as const,
        usage,
        warnings: [] as const,
      };
    },
    async doStream() {
      const parts = [
        { type: "stream-start" as const, warnings: [] as const },
        { type: "tool-call" as const, toolCallId: "call_1", toolName, input },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: narration },
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: "tool-calls" as const, usage },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };

  // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-unsafe-type-assertion -- boundary cast: the mock implements only the slice of Mastra's LanguageModel the tests drive; the full type is large and provider-shaped
  return model as unknown as LanguageModel;
};
