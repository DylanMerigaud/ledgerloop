import { z } from "zod";

import {
  type ApprovalWorkflow as TWorkflow,
  describeCondition,
} from "@/lib/approval-workflow";

/**
 * Suggested next edits for the chat editor — generated, never hardcoded.
 *
 * The editor used to ship three fixed example chips ("Route Marketing purchases
 * through a marketing lead") that often made no sense for the workflow on screen.
 * Instead the model looks at THIS workflow and proposes up to three short, clickable
 * instructions that would genuinely change it — and is told to return NOTHING if it
 * can't find anything sensible. So a chip is always a real, applicable next step.
 *
 * Each suggestion is phrased exactly as the user would type it (it's fed straight
 * back into the same chat-edit flow when clicked).
 */

// NOTE: no `.max()` here — structured-output JSON schema rejects `maxItems`. The
// "up to three" cap is enforced in code (`parseSuggestions`) after validation.
export const WorkflowSuggestions = z
  .object({
    /** Short edit instructions; empty if nothing sensible applies. */
    suggestions: z.array(z.string()),
  })
  .strict();
export type WorkflowSuggestions = z.infer<typeof WorkflowSuggestions>;

export type SuggestModel = {
  /** Propose up to three relevant edit instructions for this workflow (or none). */
  suggest: (current: TWorkflow) => Promise<string[]>;
};

export const WORKFLOW_SUGGEST_SYSTEM_PROMPT = `You help a finance ops user refine a procure-to-pay approval workflow by suggesting their next edit. You are shown the current workflow's steps. Propose UP TO THREE short instructions the user could click to improve it — phrased exactly as they would type them (e.g. "Above $50k, also require CFO approval", "Add a Slack notification when an invoice posts").

Rules:
- Keep each suggestion SHORT — under ~7 words, phrased like the examples above. No conditional clauses ("...if X is already required").
- Only suggest edits that genuinely apply to THIS workflow. Do NOT suggest something it already does.
- Supported edits: add an approval gate (optionally above an amount or for a department), add a Slack/Jira/NetSuite integration, change an existing threshold, change an approver, remove a step.
- Prefer the most useful, realistic refinements for a workflow like this one.
- If nothing sensible is missing, return an EMPTY list. An irrelevant suggestion is worse than none.

Return ONLY the JSON object matching the schema.`;

/** Compact view of the workflow for the suggest prompt (steps + their conditions). */
export const suggestPrompt = (current: TWorkflow): string => {
  const steps = current.steps
    .map((s) => {
      const who =
        s.kind === "approval" ? `approver=${s.approverTitle}` : s.integration;
      return `- ${s.kind}: "${s.label}" (${who}, when: ${describeCondition(s.when)})`;
    })
    .join("\n");
  return `CURRENT WORKFLOW STEPS:\n${steps}\n\nSuggest up to three relevant next edits as JSON, or an empty list if none apply.`;
};

/** Validate a raw model JSON value into the suggestions (or throw); cap at three. */
export const parseSuggestions = (raw: unknown): string[] =>
  WorkflowSuggestions.parse(raw).suggestions.slice(0, 3);
