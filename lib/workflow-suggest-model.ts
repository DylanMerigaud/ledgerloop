import type Anthropic from "@anthropic-ai/sdk";

import { anthropic } from "@/lib/anthropic";
import { type ApprovalWorkflow as TWorkflow } from "@/lib/approval-workflow";
import { toModelJsonSchema } from "@/lib/schema";
import {
  WORKFLOW_SUGGEST_SYSTEM_PROMPT,
  WorkflowSuggestions,
  suggestPrompt,
  parseSuggestions,
  type SuggestModel,
} from "@/lib/workflow-suggest";

/**
 * The real suggestion model — a small structured-output Anthropic call that reads
 * the current workflow and returns up to three relevant edit instructions (or an
 * empty list). Haiku: this is a quick, cheap "what's missing here" pass, not deep
 * reasoning, and it runs once as part of onboarding.
 */

const SUGGEST_MODEL = "claude-haiku-4-5";
const SUGGEST_JSON_SCHEMA = toModelJsonSchema(WorkflowSuggestions);

export const anthropicSuggestModel: SuggestModel = {
  async suggest(current: TWorkflow) {
    const message = await anthropic().messages.create({
      model: SUGGEST_MODEL,
      max_tokens: 256,
      system: WORKFLOW_SUGGEST_SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: SUGGEST_JSON_SCHEMA },
      },
      messages: [{ role: "user", content: suggestPrompt(current) }],
    });
    if (message.stop_reason === "refusal") return [];
    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return parseSuggestions(JSON.parse(raw));
  },
};
