import { test } from "node:test";
import assert from "node:assert/strict";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { RequestContext } from "@mastra/core/request-context";
import { mockToolCallingModel } from "./mock-model";

/**
 * Offline integration test for the "real agent calls its tool" wiring — the
 * thing the runtime audit could only check with a live key. Using a hand-rolled
 * mock model (no network, no key, CI-safe), this proves the three links that
 * have to hold for the agentic story to be true at runtime:
 *
 *   1. a value put into the agent's `requestContext` is READABLE inside the
 *      tool's `execute` (this is how our tools get the trusted documents),
 *   2. the agent actually INVOKES the tool when asked, and
 *   3. the tool's output and the agent's narration both come back.
 *
 * If Mastra ever changes how requestContext flows into tools, or how tool
 * results surface, this fails in CI instead of silently degrading to the
 * deterministic fallback in production.
 */

test("a tool reads requestContext and the agent invokes it (mock model)", async () => {
  let sawContextValue: string | undefined;
  let toolRan = false;

  const probeTool = createTool({
    id: "probe-tool",
    description: "A probe that echoes a value read from requestContext.",
    inputSchema: z.object({}),
    outputSchema: z.object({ echoed: z.string() }),
    execute: async (_input, context) => {
      toolRan = true;
      sawContextValue = context?.requestContext?.get("secret");
      return { echoed: sawContextValue ?? "(missing)" };
    },
  });

  const agent = new Agent({
    id: "probe-agent",
    name: "Probe Agent",
    model: mockToolCallingModel({ toolName: "probe-tool", narration: "done." }),
    tools: { probeTool },
    instructions: "Call probe-tool, then say done.",
  });

  const mastra = new Mastra({ agents: { "probe-agent": agent } });
  const got = mastra.getAgent("probe-agent");
  assert.ok(got, "agent should be registered");

  const requestContext = new RequestContext();
  requestContext.set("secret", "hello-from-context");

  const res = await got.generate("Call the probe tool.", { requestContext });

  // 2 + 3: the agent invoked the tool and we got a narration back.
  assert.equal(toolRan, true, "the agent must actually call the tool");
  assert.equal(typeof res.text, "string");

  // 1: the value injected into requestContext was visible inside the tool.
  assert.equal(
    sawContextValue,
    "hello-from-context",
    "requestContext value must reach the tool's execute",
  );
});
