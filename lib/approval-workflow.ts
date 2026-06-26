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
  /** The billing vendor, e.g. "Severn Steelworks". Routes a vendor-specific review. */
  "vendor",
  /** The invoice currency, e.g. "USD" | "EUR" | "GBP". Routes an FX review. */
  "currency",
  /** "two_way" (no goods receipt, e.g. services) | "three_way". */
  "matchType",
  /** A matching exception code the invoice raised, e.g. "vendor_inactive",
      "price_variance". Tested as MEMBERSHIP: `== code` means "the invoice has this
      flag", `!= code` means "it doesn't". */
  "exceptionCode",
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
export type InvoiceContext = {
  amount: number;
  exceptionAmount: number;
  variancePct: number;
  department: string;
  verdict: "clean" | "exception" | "duplicate";
  vendor: string;
  currency: string;
  matchType: "two_way" | "three_way";
  /** Every matching exception code the invoice raised (a `== code` leaf tests
      membership in this list, not equality with a single value). */
  exceptionCodes: string[];
};

/** The scalar value of a comparable field. `exceptionCode` is NOT here — it's a list
    (set membership), handled directly in `evaluateCondition`. */
const valueFor = (
  field: Exclude<ConditionField, "exceptionCode">,
  ctx: InvoiceContext,
): string | number => {
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
    case "vendor":
      return ctx.vendor;
    case "currency":
      return ctx.currency;
    case "matchType":
      return ctx.matchType;
  }
};

const compare = (
  left: string | number,
  op: ConditionOp,
  right: string | number,
): boolean => {
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
};

/** Evaluate a condition against an invoice context. Pure. */
export const evaluateCondition = (
  cond: Condition,
  ctx: InvoiceContext,
): boolean => {
  switch (cond.kind) {
    case "always":
      return true;
    case "leaf":
      // exceptionCode is set-membership, not a scalar compare: `== code` is "the
      // invoice raised this flag", `!= code` is "it didn't"; other ops are meaningless.
      if (cond.field === "exceptionCode") {
        const has = ctx.exceptionCodes.includes(String(cond.value));
        if (cond.op === "==") return has;
        if (cond.op === "!=") return !has;
        return false;
      }
      return compare(valueFor(cond.field, ctx), cond.op, cond.value);
    case "all":
      return cond.conditions.every((c) => evaluateCondition(c, ctx));
    case "any":
      return cond.conditions.some((c) => evaluateCondition(c, ctx));
  }
};

/** Render a condition as a short human string, for traces and the UI. */
export const describeCondition = (cond: Condition): string => {
  switch (cond.kind) {
    case "always":
      return "always";
    case "leaf":
      return `${cond.field} ${cond.op} ${describeLeafValue(cond)}`;
    case "all":
      return cond.conditions.map(describeCondition).join(" and ");
    case "any":
      return cond.conditions.map(describeCondition).join(" or ");
  }
};

/**
 * Format a leaf's value for display. The `amount` field is money, so show it as a
 * dollar figure with thousands separators ("$25,000") — the seed amounts are USD;
 * the threshold itself is currency-agnostic (it's compared to the invoice amount
 * whatever its currency), but "$25,000" reads far better than a bare "25000".
 */
const describeLeafValue = (
  cond: Extract<Condition, { kind: "leaf" }>,
): string => {
  if (cond.field === "amount" && typeof cond.value === "number") {
    return `$${cond.value.toLocaleString("en-US")}`;
  }
  return String(cond.value);
};

/**
 * Render a condition as a SHORT, plain-English phrase for the UI chip — a business
 * rule, not code ("Over $25,000", "IT only") instead of "amount > 25000". Recursive,
 * so nested all/any read naturally ("Exception · over $10,000 or variance ≥ 10%").
 * `describeCondition` stays the canonical machine-ish form (prompts, diff, traces);
 * this is display-only.
 */
export const humanizeCondition = (cond: Condition): string => {
  switch (cond.kind) {
    case "always":
      return "Always";
    case "leaf":
      return humanizeLeaf(cond);
    case "all":
      return cond.conditions.map(humanizeCondition).join(" · ");
    case "any":
      return cond.conditions.map(humanizeCondition).join(" or ");
  }
};

const money = (v: number): string => `$${v.toLocaleString("en-US")}`;
const pct = (v: number): string => `${Math.round(v * 100)}%`;

const humanizeLeaf = (cond: Extract<Condition, { kind: "leaf" }>): string => {
  const { field, op, value } = cond;
  const num = typeof value === "number" ? value : 0;

  if (field === "amount" || field === "exceptionAmount") {
    const what = field === "amount" ? "" : "exception ";
    if (op === ">" || op === ">=") return `Over ${what}${money(num)}`;
    if (op === "<" || op === "<=") return `Under ${what}${money(num)}`;
  }
  if (field === "variancePct") {
    if (op === ">" || op === ">=") return `Variance ≥ ${pct(num)}`;
    if (op === "<" || op === "<=") return `Variance < ${pct(num)}`;
  }
  if (field === "department") {
    if (op === "==") return `${String(value)} only`;
    if (op === "!=") return `Not ${String(value)}`;
  }
  if (field === "verdict" && op === "==") {
    return value === "exception" ? "Exception" : `${String(value)}`;
  }
  if (field === "vendor") {
    if (op === "==") return `Vendor: ${String(value)}`;
    if (op === "!=") return `Not ${String(value)}`;
  }
  if (field === "currency") {
    if (op === "==") return `${String(value)} only`;
    if (op === "!=") return `Not ${String(value)}`;
  }
  if (field === "matchType" && op === "==") {
    return value === "two_way" ? "2-way match" : "3-way match";
  }
  if (field === "exceptionCode") {
    // Codes read better with spaces: "vendor_inactive" → "vendor inactive".
    const label = String(value).replace(/_/g, " ");
    if (op === "==") return `Has ${label} flag`;
    if (op === "!=") return `No ${label} flag`;
  }
  // Fallback for any op/field combo not specially phrased.
  return `${field} ${op} ${describeLeafValue(cond)}`;
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  Diff — compare two workflows (for the chat-edit preview)
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * A conversational edit produces a PROPOSED workflow; nothing is applied until a
 * human approves. The preview is this diff between the current (live) workflow and
 * the proposal: which steps were added, removed, or changed. Pure + keyed on step
 * id, so it's testable and the UI can colour the graph from it.
 */

export type StepChange =
  | { kind: "added"; id: string; label: string }
  | { kind: "removed"; id: string; label: string }
  | { kind: "changed"; id: string; label: string; fields: string[] }
  | { kind: "unchanged"; id: string; label: string };

/** Human-readable summary of how one step differs between two workflows. */
const stepFieldDiffs = (a: WorkflowStep, b: WorkflowStep): string[] => {
  const fields: string[] = [];
  if (a.kind !== b.kind) fields.push("type");
  if (a.label !== b.label) fields.push("label");
  if (describeCondition(a.when) !== describeCondition(b.when))
    fields.push("condition");
  const aAppr = a.kind === "approval" ? a.approverName : null;
  const bAppr = b.kind === "approval" ? b.approverName : null;
  if (aAppr !== bAppr) fields.push("approver");
  const aTitle = a.kind === "approval" ? a.approverTitle : null;
  const bTitle = b.kind === "approval" ? b.approverTitle : null;
  if (aTitle !== bTitle) fields.push("role");
  if (a.next.join(",") !== b.next.join(",")) fields.push("routing");
  return fields;
};

/** Diff two workflows by step id: added / removed / changed / unchanged. @public */
export const diffWorkflows = (
  current: ApprovalWorkflow,
  proposed: ApprovalWorkflow,
): StepChange[] => {
  const cur = new Map(current.steps.map((s) => [s.id, s]));
  const prop = new Map(proposed.steps.map((s) => [s.id, s]));
  const changes: StepChange[] = [];

  // Added / changed / unchanged — iterate the proposal (the new shape).
  for (const [id, p] of prop) {
    const c = cur.get(id);
    if (!c) {
      changes.push({ kind: "added", id, label: p.label });
      continue;
    }
    const fields = stepFieldDiffs(c, p);
    changes.push(
      fields.length > 0
        ? { kind: "changed", id, label: p.label, fields }
        : { kind: "unchanged", id, label: p.label },
    );
  }
  // Removed — in current but not in the proposal.
  for (const [id, c] of cur) {
    if (!prop.has(id)) changes.push({ kind: "removed", id, label: c.label });
  }
  return changes;
};

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
