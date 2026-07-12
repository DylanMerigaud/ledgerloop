import type Anthropic from "@anthropic-ai/sdk";

import type { PlanModel } from "@/lib/workflow-edit-agent";

import { anthropic } from "@/lib/anthropic";
import { type ApprovalWorkflow as TWorkflow } from "@/lib/approval-workflow";
import {
  type EditModel,
  editPrompt,
  jsonFromModelText,
  parseEditOp,
  parseEditPlan,
  planPrompt,
  WORKFLOW_EDIT_SYSTEM_PROMPT,
  WORKFLOW_PLAN_SYSTEM_PROMPT,
} from "@/lib/workflow-edit";

/**
 * The real conversational-edit model, a structured-output Anthropic call that maps
 * an instruction to ONE small `WorkflowEditOp` (not the whole workflow). The op
 * schema is tiny and flat, so it stays well inside the structured-output grammar
 * limit and the model never round-trips (and silently drifts) the existing nested
 * conditions. Deterministic `applyEditOp` then applies it. Sonnet, picking the
 * right op + scope is real reasoning; edits are interactive but infrequent.
 */

const EDIT_MODEL = "claude-sonnet-4-6";

export const anthropicEditModel: EditModel = {
  async planEdit(current: TWorkflow, instruction: string) {
    const message = await anthropic().messages.create({
      model: EDIT_MODEL,
      max_tokens: 512,
      system: WORKFLOW_EDIT_SYSTEM_PROMPT,
      // No structured output (same reason as planOps below): the op's recursive
      // `Condition` blows past Anthropic's 16-union-param schema limit. The prompt
      // asks for JSON and `parseEditOp` Zod-validates it.
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
    return parseEditOp(jsonFromModelText(raw));
  },
};

/**
 * The agent's planner, returns an ORDERED list of ops for a (possibly multi-part)
 * instruction, and on a correction pass takes the validation issues as feedback.
 * `runEditAgent` drives the loop (apply → validate → correct). Same Sonnet model.
 */
export const anthropicPlanModel: PlanModel = {
  async planOps({ current, instruction, available, feedback }) {
    const message = await anthropic().messages.create({
      model: EDIT_MODEL,
      max_tokens: 1024,
      system: WORKFLOW_PLAN_SYSTEM_PROMPT,
      // No `output_config` structured output here: the ops carry the recursive
      // `Condition` (all/any/leaf/always), which expands to >16 union-typed params
      // and Anthropic REJECTS the schema (400: too many union parameters). The system
      // prompt already asks for JSON and `parseEditPlan` Zod-validates the reply, so we
      // parse the text ourselves and keep the same safety.
      messages: [
        {
          role: "user",
          content: planPrompt(current, instruction, available, feedback),
        },
      ],
    });
    if (message.stop_reason === "refusal") {
      throw new Error("Edit model refused the request.");
    }
    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return parseEditPlan(jsonFromModelText(raw));
  },
};
