import type Anthropic from "@anthropic-ai/sdk";

import { anthropic } from "@/lib/anthropic";
import { type ApprovalWorkflow as TWorkflow } from "@/lib/approval-workflow";
import { toModelJsonSchema } from "@/lib/schema";
import {
  WORKFLOW_EDIT_SYSTEM_PROMPT,
  WORKFLOW_PLAN_SYSTEM_PROMPT,
  WorkflowEditOp,
  WorkflowEditPlan,
  editPrompt,
  planPrompt,
  parseEditOp,
  parseEditPlan,
  type EditModel,
} from "@/lib/workflow-edit";
import type { PlanModel } from "@/lib/workflow-edit-agent";

/**
 * The real conversational-edit model — a structured-output Anthropic call that maps
 * an instruction to ONE small `WorkflowEditOp` (not the whole workflow). The op
 * schema is tiny and flat, so it stays well inside the structured-output grammar
 * limit and the model never round-trips (and silently drifts) the existing nested
 * conditions. Deterministic `applyEditOp` then applies it. Sonnet — picking the
 * right op + scope is real reasoning; edits are interactive but infrequent.
 */

const EDIT_MODEL = "claude-sonnet-4-6";
const EDIT_OP_JSON_SCHEMA = toModelJsonSchema(WorkflowEditOp);

export const anthropicEditModel: EditModel = {
  async planEdit(current: TWorkflow, instruction: string) {
    const message = await anthropic().messages.create({
      model: EDIT_MODEL,
      max_tokens: 512,
      system: WORKFLOW_EDIT_SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: EDIT_OP_JSON_SCHEMA },
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
    return parseEditOp(JSON.parse(raw));
  },
};

/**
 * The agent's planner — returns an ORDERED list of ops for a (possibly multi-part)
 * instruction, and on a correction pass takes the validation issues as feedback.
 * `runEditAgent` drives the loop (apply → validate → correct). Same Sonnet model.
 */
const PLAN_JSON_SCHEMA = toModelJsonSchema(WorkflowEditPlan);

export const anthropicPlanModel: PlanModel = {
  async planOps({ current, instruction, feedback }) {
    const message = await anthropic().messages.create({
      model: EDIT_MODEL,
      max_tokens: 1024,
      system: WORKFLOW_PLAN_SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: PLAN_JSON_SCHEMA },
      },
      messages: [
        { role: "user", content: planPrompt(current, instruction, feedback) },
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
    return parseEditPlan(JSON.parse(raw));
  },
};
