import Anthropic from "@anthropic-ai/sdk";
import { toModelJsonSchema } from "./schema";
import {
  ApprovalWorkflow,
  type ApprovalWorkflow as TWorkflow,
} from "./approval-workflow";
import {
  WORKFLOW_EDIT_SYSTEM_PROMPT,
  editPrompt,
  parseWorkflow,
  type EditModel,
} from "./workflow-edit";

/**
 * The real conversational-edit model — a structured-output Anthropic call that
 * rewrites an approval workflow from an instruction. Same discipline as the
 * onboarding model: hand the model the JSON schema derived from the Zod object,
 * then `ApprovalWorkflow.parse` the result (an invalid edit is rejected, never
 * applied). Sonnet — the edit must preserve a valid graph while making a targeted
 * change, which is real reasoning, and edits are interactive-but-infrequent.
 */

const EDIT_MODEL = "claude-sonnet-4-6";
const WORKFLOW_JSON_SCHEMA = toModelJsonSchema(ApprovalWorkflow);

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

export const anthropicEditModel: EditModel = {
  async edit(current: TWorkflow, instruction: string) {
    const message = await getClient().messages.create({
      model: EDIT_MODEL,
      max_tokens: 2048,
      system: WORKFLOW_EDIT_SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: WORKFLOW_JSON_SCHEMA },
      },
      messages: [{ role: "user", content: editPrompt(current, instruction) }],
    });
    if (message.stop_reason === "refusal") {
      throw new Error("Edit model refused the request.");
    }
    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return parseWorkflow(JSON.parse(raw));
  },
};
