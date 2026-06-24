import { z } from "zod";

/**
 * Conditional approval workflow — the DAG model.
 *
 * Procure-to-pay approval is a graph: a manager review fans out to a director
 * step (only when the PO clears a threshold), a department review, an ERP post at
 * the end. This file is the data model for that graph plus a pure evaluator for
 * the conditions on each edge. It is deliberately a separate module from the
 * per-invoice `schema.ts`: this is the ONBOARDING artifact (what the discovery
 * agent derives and a human validates), not part of an invoice's own shape.
 *
 * The differentiator vs a hand-built workflow tool: `approverTitle` here is a
 * ROLE, not a person. The onboarding agent resolves it to a real employee using
 * the org chart (the manager of X, the director above them). The workflow is
 * derived from the HRIS, not typed in by hand.
 *
 * Nothing executes here — execution is the engine (lib/approval-engine.ts). This
 * module is types + a side-effect-free `evaluateCondition`, so it's trivially
 * testable and safe to import anywhere (agent, engine, UI).
 *
 * @public — the workflow model is the public vocabulary the engine, the
 * onboarding agent, and the UI/canvas all speak.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 *  Conditions — the `when` on a step
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The fields a condition can test about an invoice in flight. Kept small and
 * legible on purpose — these are the levers a procurement team actually routes
 * on, and every one must be explainable on a sales call.
 */
const ConditionField = z.enum([
  /** Invoice total. The classic "PO > $5,000 needs a director" lever. */
  "amount",
  /** The exception amount at stake (0 on a clean invoice). */
  "exceptionAmount",
  /** Max line variance as a fraction (0.07 = 7%). */
  "variancePct",
  /** The buying department, e.g. "IT", "Finance". Routes a category review. */
  "department",
  /** matching verdict: "clean" | "exception" | "duplicate". */
  "verdict",
]);
type ConditionField = z.infer<typeof ConditionField>;

const ConditionOp = z.enum([">", ">=", "<", "<=", "==", "!="]);
type ConditionOp = z.infer<typeof ConditionOp>;

/**
 * A condition is either a leaf comparison, a boolean combinator over
 * sub-conditions, or the constant `always` (a step with no gate). Recursive, so
 * Zod needs the explicit type + `z.lazy`.
 */
export type Condition =
  | { kind: "always" }
  | {
      kind: "leaf";
      field: ConditionField;
      op: ConditionOp;
      value: string | number;
    }
  | { kind: "all"; conditions: Condition[] }
  | { kind: "any"; conditions: Condition[] };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("always") }).strict(),
    z
      .object({
        kind: z.literal("leaf"),
        field: ConditionField,
        op: ConditionOp,
        value: z.union([z.string(), z.number()]),
      })
      .strict(),
    z
      .object({ kind: z.literal("all"), conditions: z.array(Condition) })
      .strict(),
    z
      .object({ kind: z.literal("any"), conditions: z.array(Condition) })
      .strict(),
  ]),
);

/* ────────────────────────────────────────────────────────────────────────── *
 *  Steps + the workflow graph
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * An approval step: a named human gate. `approverTitle` is the ROLE the agent
 * derived (e.g. "Director", "VP of IT"); `approverName` is the person the agent
 * resolved from the org chart, or null if it couldn't (which is itself something
 * the human resolves at validation time).
 */
/** @public — an approval gate in the workflow (rendered by the UI/canvas). */
export const ApprovalStep = z
  .object({
    id: z.string().min(1),
    kind: z.literal("approval"),
    label: z.string(),
    when: Condition,
    approverTitle: z.string(),
    approverName: z.string().nullable(),
    /** Ids of the steps that run after this one (parallel fan-out when >1). */
    next: z.array(z.string()),
  })
  .strict();
export type ApprovalStep = z.infer<typeof ApprovalStep>;

/** @public — the system actions an integration step can run. */
export const IntegrationKind = z.enum(["slack", "jira", "netsuite"]);
export type IntegrationKind = z.infer<typeof IntegrationKind>;

/**
 * An integration step: a system action (notify Slack, open a Jira ticket, post
 * the bill to NetSuite). All are simulated like the ERP stub today EXCEPT
 * NetSuite, which has a real adapter — the engine decides how to run each.
 */
/** @public — an integration step in the workflow (rendered by the UI/canvas). */
export const IntegrationStep = z
  .object({
    id: z.string().min(1),
    kind: z.literal("integration"),
    label: z.string(),
    when: Condition,
    integration: IntegrationKind,
    next: z.array(z.string()),
  })
  .strict();
export type IntegrationStep = z.infer<typeof IntegrationStep>;

export const WorkflowStep = z.discriminatedUnion("kind", [
  ApprovalStep,
  IntegrationStep,
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;

/**
 * The whole approval workflow: a set of steps plus the ids of the roots (the
 * steps with no incoming edge, where execution starts). A DAG, not a list — the
 * `next` edges define the shape, `roots` the entry points. The engine walks it;
 * the UI draws it; the agent produces it.
 */
export const ApprovalWorkflow = z
  .object({
    name: z.string(),
    steps: z.array(WorkflowStep),
    roots: z.array(z.string()),
  })
  .strict();
export type ApprovalWorkflow = z.infer<typeof ApprovalWorkflow>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Evaluation — pure, no side effects
 * ────────────────────────────────────────────────────────────────────────── */

/** The facts about an invoice a condition is evaluated against. */
export interface InvoiceContext {
  amount: number;
  exceptionAmount: number;
  variancePct: number;
  department: string;
  verdict: "clean" | "exception" | "duplicate";
}

function valueFor(field: ConditionField, ctx: InvoiceContext): string | number {
  switch (field) {
    case "amount":
      return ctx.amount;
    case "exceptionAmount":
      return ctx.exceptionAmount;
    case "variancePct":
      return ctx.variancePct;
    case "department":
      return ctx.department;
    case "verdict":
      return ctx.verdict;
  }
}

function compare(
  left: string | number,
  op: ConditionOp,
  right: string | number,
): boolean {
  // Numeric comparison when both sides are numbers; otherwise string equality
  // (only == / != are meaningful for strings).
  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case ">":
        return left > right;
      case ">=":
        return left >= right;
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case "==":
        return left === right;
      case "!=":
        return left !== right;
    }
  }
  const l = String(left);
  const r = String(right);
  switch (op) {
    case "==":
      return l === r;
    case "!=":
      return l !== r;
    // Ordering on strings isn't meaningful here — treat as false rather than
    // surprising lexicographic results.
    default:
      return false;
  }
}

/** Evaluate a condition against an invoice context. Pure. */
export function evaluateCondition(
  cond: Condition,
  ctx: InvoiceContext,
): boolean {
  switch (cond.kind) {
    case "always":
      return true;
    case "leaf":
      return compare(valueFor(cond.field, ctx), cond.op, cond.value);
    case "all":
      return cond.conditions.every((c) => evaluateCondition(c, ctx));
    case "any":
      return cond.conditions.some((c) => evaluateCondition(c, ctx));
  }
}

/** Render a condition as a short human string, for traces and the UI. */
export function describeCondition(cond: Condition): string {
  switch (cond.kind) {
    case "always":
      return "always";
    case "leaf":
      return `${cond.field} ${cond.op} ${cond.value}`;
    case "all":
      return cond.conditions.map(describeCondition).join(" and ");
    case "any":
      return cond.conditions.map(describeCondition).join(" or ");
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Onboarding: the FUZZY decisions the agent makes (not the whole DAG)
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * The DAG STRUCTURE is a deterministic P2P template (manager → director-gated →
 * department-review-gated → post). What's genuinely fuzzy — and the only thing
 * the model is asked for — is: who in THIS org sits at each approval level, what
 * amount threshold makes sense, and how to explain it all in plain language. The
 * model returns these decisions; deterministic code assembles them into a
 * validated `ApprovalWorkflow` (lib/onboarding.ts). This keeps the model off the
 * graph plumbing (edge ids, validity) and on the judgement, where it earns its
 * place — and keeps the structure unit-testable.
 */

/** The model's resolution of one approval role to a person in the org. @public */
export const RoleResolution = z
  .object({
    /** The role slot in the template: "manager" | "director" | "department-head". */
    role: z.enum(["manager", "director", "department-head"]),
    /** The job title in this org the model judged fills that role. */
    title: z.string(),
    /** The person resolved from the org chart, or null if none fits. */
    employeeName: z.string().nullable(),
    /** One-line plain-language justification for a human validating it. */
    rationale: z.string(),
  })
  .strict();
export type RoleResolution = z.infer<typeof RoleResolution>;

/** The full structured output of the onboarding agent — the fuzzy parts only. */
export const OnboardingProposal = z
  .object({
    /** Amount above which a director must also approve (the "PO > $X" lever). */
    directorThreshold: z.number(),
    /** Role → person resolutions for the template's approval steps. */
    roles: z.array(RoleResolution),
    /**
     * Plain-language read of the org's data-quality issues (the OrgIssues), for
     * the human reviewer — one entry per issue the model was shown, in order.
     */
    issueNotes: z.array(z.string()),
    /** A short overall summary of the proposed workflow for the reviewer. */
    summary: z.string(),
  })
  .strict();
export type OnboardingProposal = z.infer<typeof OnboardingProposal>;
