import { z } from "zod";

import {
  type ApprovalWorkflow as TWorkflow,
  type WorkflowStep,
  type Condition,
  IntegrationKind,
  diffWorkflows,
  describeCondition,
  type StepChange,
} from "@/lib/approval-workflow";
import { nonNull } from "@/lib/assert";

/**
 * Conversational workflow editing — turn a plain-language instruction into a
 * PROPOSED workflow, never a direct mutation.
 *
 * Design (learned the hard way): the model does NOT regenerate the whole workflow.
 * Asking it to emit every step + every nested condition both drifted (it silently
 * rewrote unrelated conditions) and blew past Anthropic's structured-output grammar
 * limit. Instead the model emits ONE small, flat `WorkflowEditOp` — the intent —
 * and deterministic code (`applyEditOp`) applies it. Existing steps and their
 * conditions are copied verbatim; only the targeted step is added/changed/removed.
 * Same "AI for the fuzzy intent, code for the structure" split as onboarding.
 *
 * The result is a PROPOSAL: the engine only ever runs the CURRENT workflow; the UI
 * shows the diff and the human approves or reverts.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 *  The edit op — small + flat, so the model schema stays tiny and reliable
 * ────────────────────────────────────────────────────────────────────────── */

export const WorkflowEditOp = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add-approval"),
      /** Short label, e.g. "CFO approval". */
      label: z.string(),
      /** The role this gate is for, e.g. "CFO". */
      approverTitle: z.string(),
      /** The amount above which it applies; null = applies to every invoice. */
      amountOver: z.number().nullable(),
      /** A department it's scoped to (e.g. "IT"); null = any department. */
      department: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("add-integration"),
      label: z.string(),
      integration: IntegrationKind,
    })
    .strict(),
  z
    .object({
      op: z.literal("set-threshold"),
      /** Id of the existing approval step whose amount threshold changes. */
      stepId: z.string(),
      amountOver: z.number(),
    })
    .strict(),
  z
    .object({
      op: z.literal("set-approver"),
      stepId: z.string(),
      approverName: z.string(),
    })
    .strict(),
  z.object({ op: z.literal("remove-step"), stepId: z.string() }).strict(),
  /** The model couldn't map the instruction to a supported edit — change nothing. */
  z.object({ op: z.literal("none"), reason: z.string() }).strict(),
]);
export type WorkflowEditOp = z.infer<typeof WorkflowEditOp>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Apply — pure, deterministic, never touches unrelated steps
 * ────────────────────────────────────────────────────────────────────────── */

/** Slugify a label into a stable step id. */
const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "step";

/** A condition from an amount/department scope (mirrors the onboarding template). */
const conditionFor = (
  amountOver: number | null,
  department: string | null,
): Condition => {
  const leaves: Condition[] = [];
  if (amountOver !== null)
    leaves.push({ kind: "leaf", field: "amount", op: ">", value: amountOver });
  if (department !== null)
    leaves.push({
      kind: "leaf",
      field: "department",
      op: "==",
      value: department,
    });
  if (leaves.length === 0) return { kind: "always" };
  if (leaves.length === 1)
    return nonNull(leaves[0], "exactly one leaf when length is 1");
  return { kind: "all", conditions: leaves };
};

/** The final integration step everything routes into (the post), if any. */
const postStepId = (wf: TWorkflow): string | null =>
  wf.steps.find((s) => s.kind === "integration" && s.next.length === 0)?.id ??
  null;

/**
 * Apply one edit op to a workflow, returning a NEW workflow (input untouched).
 * Unlisted steps and their conditions are carried over byte-for-byte.
 */
export const applyEditOp = (wf: TWorkflow, op: WorkflowEditOp): TWorkflow => {
  // Deep clone so we never mutate the caller's current workflow.
  const next: TWorkflow = JSON.parse(JSON.stringify(wf)) as TWorkflow;

  switch (op.op) {
    case "none":
      return next;

    case "set-threshold": {
      const step = next.steps.find((s) => s.id === op.stepId);
      if (step && step.kind === "approval") {
        step.when = mergeAmount(step.when, op.amountOver);
      }
      return next;
    }

    case "set-approver": {
      const step = next.steps.find((s) => s.id === op.stepId);
      if (step && step.kind === "approval") step.approverName = op.approverName;
      return next;
    }

    case "remove-step": {
      next.steps = next.steps.filter((s) => s.id !== op.stepId);
      for (const s of next.steps)
        s.next = s.next.filter((n) => n !== op.stepId);
      next.roots = next.roots.filter((r) => r !== op.stepId);
      return next;
    }

    case "add-approval": {
      const id = uniqueId(next, slug(op.label));
      const post = postStepId(next);
      const newStep: WorkflowStep = {
        id,
        kind: "approval",
        label: op.label,
        when: conditionFor(op.amountOver, op.department),
        approverTitle: op.approverTitle,
        approverName: null, // a human resolves the person at validation
        next: post ? [post] : [],
      };
      // Insert after the root gate (fan-out), before the post.
      const rootId = next.roots[0];
      const root = next.steps.find((s) => s.id === rootId);
      if (root && !root.next.includes(id)) root.next = [...root.next, id];
      next.steps.push(newStep);
      return next;
    }

    case "add-integration": {
      const id = uniqueId(next, slug(op.label));
      // An integration "when an invoice posts" runs after the post step.
      const post = postStepId(next);
      const newStep: WorkflowStep = {
        id,
        kind: "integration",
        label: op.label,
        when: { kind: "always" },
        integration: op.integration,
        next: [],
      };
      const postStep = next.steps.find((s) => s.id === post);
      if (postStep && !postStep.next.includes(id))
        postStep.next = [...postStep.next, id];
      next.steps.push(newStep);
      return next;
    }
  }
};

/** Replace just the amount comparison inside a condition, keeping the rest. */
const mergeAmount = (when: Condition, amountOver: number): Condition => {
  const amountLeaf: Condition = {
    kind: "leaf",
    field: "amount",
    op: ">",
    value: amountOver,
  };
  if (when.kind === "leaf")
    return when.field === "amount"
      ? amountLeaf
      : { kind: "all", conditions: [when, amountLeaf] };
  if (when.kind === "all" || when.kind === "any") {
    const others = when.conditions.filter(
      (c) => !(c.kind === "leaf" && c.field === "amount"),
    );
    return { kind: when.kind, conditions: [...others, amountLeaf] };
  }
  return amountLeaf; // was `always`
};

const uniqueId = (wf: TWorkflow, base: string): string => {
  if (!wf.steps.some((s) => s.id === base)) return base;
  let i = 2;
  while (wf.steps.some((s) => s.id === `${base}-${i}`)) i++;
  return `${base}-${i}`;
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  The flow: model → op → apply → diff
 * ────────────────────────────────────────────────────────────────────────── */

export type EditModel = {
  /** Map a plain-language instruction to one structured edit op. */
  planEdit: (
    current: TWorkflow,
    instruction: string,
  ) => Promise<WorkflowEditOp>;
};

export type EditResult = {
  proposed: TWorkflow;
  op: WorkflowEditOp;
  changes: StepChange[];
};

/**
 * Plan an edit (model → op), apply it deterministically, and diff. Applies nothing
 * to the live workflow — the caller shows the diff and the human approves.
 */
export const proposeEdit = async (
  model: EditModel,
  current: TWorkflow,
  instruction: string,
): Promise<EditResult> => {
  const op = await model.planEdit(current, instruction);
  const proposed = applyEditOp(current, op);
  return { proposed, op, changes: diffWorkflows(current, proposed) };
};

export const WORKFLOW_EDIT_SYSTEM_PROMPT = `You translate a plain-language instruction into ONE structured edit for a procure-to-pay approval workflow. You are given the current workflow's steps (id, label, kind, approver) and the instruction. Return a single edit op:

- add-approval: a new human approval gate. Set "approverTitle" (the role, e.g. "CFO"), "amountOver" (the dollar threshold it applies above, or null for every invoice), and "department" (scope to one department like "IT", or null for any).
- add-integration: a system action — "slack", "jira", or "netsuite" — that runs when an invoice posts.
- set-threshold: change an existing approval step's amount threshold. Use the step's "stepId" from the current workflow.
- set-approver: set the person on an existing approval step (by "stepId").
- remove-step: remove a step by "stepId".
- none: if the instruction doesn't map to any of the above, or asks for something already true — give a short "reason".

Pick the SINGLE op that best matches. If the instruction asks for something the workflow already does, return "none" with a reason. Return only the JSON op.`;

/** The prompt body: a compact view of the current steps (incl. their CONDITIONS,
    so the model can tell when an instruction is already satisfied) + the instruction. */
export const editPrompt = (current: TWorkflow, instruction: string): string => {
  const steps = current.steps
    .map((s) => {
      const who =
        s.kind === "approval" ? `approver=${s.approverTitle}` : s.integration;
      return `- ${s.id} (${s.kind}: "${s.label}", ${who}, when: ${describeCondition(s.when)})`;
    })
    .join("\n");
  return `CURRENT STEPS:\n${steps}\n\nINSTRUCTION:\n${instruction}\n\nIf the workflow already satisfies the instruction (a step with that role/threshold/condition already exists), return op "none". Otherwise return one edit op as JSON.`;
};

/** Validate a raw model JSON value into a WorkflowEditOp (or throw). */
export const parseEditOp = (raw: unknown): WorkflowEditOp =>
  WorkflowEditOp.parse(raw);
