import {
  ApprovalWorkflow,
  type ApprovalWorkflow as TWorkflow,
  diffWorkflows,
  type StepChange,
} from "./approval-workflow";

/**
 * Conversational workflow editing — turn a natural-language instruction into a
 * PROPOSED workflow, never a direct mutation.
 *
 * The competitor builders make you edit the canvas by hand. Here you say what you
 * want ("above $10k add a CFO approval", "IT review only for hardware") and the
 * agent rewrites the workflow. Crucially, the result is a PROPOSAL: the engine
 * only ever executes the CURRENT workflow, and the UI shows the diff for the human
 * to approve or revert. Same "agent proposes, human decides" discipline as the
 * rest of the product.
 *
 * The model emits a full `ApprovalWorkflow` (the edit can touch any part of the
 * graph), validated by Zod before it's shown — an instruction that would produce
 * an invalid workflow is rejected, not applied. This module is the prompt + parse
 * + diff; the model is injected so it's testable with a fake.
 */

export interface EditModel {
  edit: (current: TWorkflow, instruction: string) => Promise<TWorkflow>;
}

export interface EditResult {
  proposed: TWorkflow;
  changes: StepChange[];
}

/**
 * Run an edit instruction against the current workflow and return the proposal +
 * its diff. Does NOT apply anything — the caller (UI) shows the diff and the human
 * approves before `proposed` ever becomes the live workflow.
 */
export async function proposeEdit(
  model: EditModel,
  current: TWorkflow,
  instruction: string,
): Promise<EditResult> {
  const proposed = await model.edit(current, instruction);
  return { proposed, changes: diffWorkflows(current, proposed) };
}

export const WORKFLOW_EDIT_SYSTEM_PROMPT = `You edit procure-to-pay approval workflows. You are given the CURRENT workflow as JSON and a plain-language instruction, and you return the COMPLETE updated workflow as JSON matching the schema.

Rules:
- Make ONLY the change the instruction asks for. Preserve every other step, condition, approver, and edge exactly.
- Keep the graph valid: every id in a step's "next" must be a real step id; "roots" lists the entry steps (no incoming edge); it must stay a DAG (no cycles).
- Conditions use the fields amount, exceptionAmount, variancePct (a fraction, e.g. 0.1 = 10%), department, verdict — with ops >, >=, <, <=, ==, != — combined via { kind: "all" | "any", conditions: [...] } or { kind: "always" }.
- Approval steps need an approverTitle (the role) and approverName (a person, or null if unknown — do not invent a name). Integration steps need an "integration" of "slack" | "jira" | "netsuite".
- When adding a step, wire it into the existing flow sensibly (usually after the manager gate, before the final post) and give it a clear "label".
- Return ONLY the JSON workflow object. No commentary.`;

/** The prompt body for one edit (system prompt is separate). */
export function editPrompt(current: TWorkflow, instruction: string): string {
  return `CURRENT WORKFLOW:\n${JSON.stringify(current, null, 2)}\n\nINSTRUCTION:\n${instruction}\n\nReturn the complete updated workflow as JSON.`;
}

/** Validate a raw model JSON value into an ApprovalWorkflow (or throw). */
export function parseWorkflow(raw: unknown): TWorkflow {
  return ApprovalWorkflow.parse(raw);
}
