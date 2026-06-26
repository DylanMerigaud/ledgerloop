import {
  OnboardingProposal,
  type OnboardingProposal as TProposal,
  type ApprovalWorkflow,
  type WorkflowStep,
  type Condition,
} from "@/lib/approval-workflow";
import { DEFAULT_APPROVAL_POLICY } from "@/lib/client-profile";
import type { OrgChart } from "@/lib/schema";

/**
 * Onboarding discovery — turn a client's org into an approval workflow.
 *
 * This is the forward-deployed-engineer piece: connect the HRIS, and out comes a
 * conditional approval DAG ready for a human to validate. The split is the same
 * "AI at the edges, deterministic core" discipline as the rest of the repo:
 *
 *   • The DAG STRUCTURE is a deterministic P2P template — manager review (always),
 *     a director step gated on amount, a department-review step gated on
 *     department, and a final NetSuite post. Code builds this; it's unit-testable
 *     and the edge/id plumbing is never the model's problem.
 *   • The FUZZY decisions are the model's job: which titles in THIS org fill the
 *     manager / director / department-head slots, which real person that resolves
 *     to, what amount threshold is sensible, and a plain-language read of the org's
 *     data-quality issues. That's the `OnboardingProposal`.
 *
 * `deriveWorkflow` runs the model for the proposal, then `assembleWorkflow`
 * (pure) stitches the proposal + org into a validated `ApprovalWorkflow`. The
 * model is injected, so the eval and tests run it identically with a fake.
 *
 * The output is a PROPOSAL a human validates — the agent decides nothing on its
 * own. Unresolved roles (`employeeName: null`) and flagged org issues are exactly
 * what the reviewer fixes before the workflow goes live.
 */

/** Anything that can produce a structured proposal from a prompt — real model or fake. */
export type ProposalModel = {
  propose: (org: OrgChart) => Promise<TProposal>;
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  Deterministic assembly — proposal + org → validated ApprovalWorkflow
 * ────────────────────────────────────────────────────────────────────────── */

/** Step ids are fixed by the template, so the engine and UI can refer to them. */
const STEP = {
  manager: "manager-review",
  director: "director-review",
  department: "department-review",
  post: "post-netsuite",
} as const;

const rolePerson = (
  proposal: TProposal,
  role: "manager" | "director" | "department-head",
): { title: string; name: string | null } => {
  const r = proposal.roles.find((x) => x.role === role);
  return { title: r?.title ?? role, name: r?.employeeName ?? null };
};

/**
 * Build the validated workflow from the model's fuzzy proposal + the org. Pure and
 * deterministic: same proposal in, same DAG out. The conditions are fixed by the
 * template; only the threshold value and the resolved approver names come from the
 * model.
 */
export const assembleWorkflow = (
  org: OrgChart,
  proposal: TProposal,
): ApprovalWorkflow => {
  const manager = rolePerson(proposal, "manager");
  const director = rolePerson(proposal, "director");
  const deptHead = rolePerson(proposal, "department-head");

  const amountOverThreshold: Condition = {
    kind: "leaf",
    field: "amount",
    op: ">",
    value: proposal.directorThreshold,
  };

  // The manager sees an invoice when it's NOT trivial: any exception, or any clean
  // bill over a floor. So a small clean invoice posts straight through (the
  // automation win), while anything material or flagged gets a human — the standard
  // AP control, not "a manager clicks approve on every $50 bill". The floor is the
  // policy default; the director threshold (scaled to the org) gates the second gate.
  const managerReview: Condition = {
    kind: "any",
    conditions: [
      { kind: "leaf", field: "verdict", op: "==", value: "exception" },
      {
        kind: "leaf",
        field: "amount",
        op: ">",
        value: DEFAULT_APPROVAL_POLICY.manager.amount,
      },
    ],
  };

  const steps: WorkflowStep[] = [
    {
      id: STEP.manager,
      kind: "approval",
      label: "Manager review",
      when: managerReview,
      approverTitle: manager.title,
      approverName: manager.name,
      // Fan-out to the director gate — NOT straight to the post (a direct
      // manager→post edge reads as "the manager can post without the other gates").
      // The post still runs for small invoices because a gate whose condition is
      // false is a transparent pass-through in the engine (AND-join), so director
      // skips → post is reached. The department review is a SEPARATE root (a
      // parallel first-line axis, not behind the manager), so when it fires it pends
      // in the SAME wave as the manager and one approval round clears both.
      next: [STEP.director],
    },
    {
      id: STEP.director,
      kind: "approval",
      // No threshold in the label — the `when amount > N` chip already shows it.
      label: "Director review",
      when: amountOverThreshold,
      approverTitle: director.title,
      approverName: director.name,
      next: [STEP.post],
    },
    {
      id: STEP.department,
      kind: "approval",
      label: "Department head review",
      // A parallel first-line gate (its own root), scoped to one department's
      // purchases. We gate on Product (a real department in the seeded org, and the
      // one carried on a seeded PO) so it actually fires in the demo; the proposal's
      // department-head rationale explains who signs off. When the invoice isn't that
      // department the gate's condition is false → it skips (transparent pass-through).
      when: { kind: "leaf", field: "department", op: "==", value: "Product" },
      approverTitle: deptHead.title,
      approverName: deptHead.name,
      next: [STEP.post],
    },
    {
      id: STEP.post,
      kind: "integration",
      label: "Post bill to NetSuite",
      when: { kind: "always" },
      integration: "netsuite",
      next: [],
    },
  ];

  return {
    name: `${org.source} approval workflow`,
    steps,
    // Manager and department head are parallel first-line roots; director hangs off
    // the manager (escalation), the post collects all paths (AND-join).
    roots: [STEP.manager, STEP.department],
  };
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  The full discovery: model proposal + assembly + carry the org issues through
 * ────────────────────────────────────────────────────────────────────────── */

export type OnboardingResult = {
  workflow: ApprovalWorkflow;
  proposal: TProposal;
  /** The org issues paired with the model's plain-language note for each.
      `employeeName` is the issue's SUBJECT (for precise UI highlighting — so the
      tree flags the person the issue is ABOUT, not anyone merely mentioned). */
  issues: { employeeName: string; detail: string; note: string }[];
};

/**
 * Run the onboarding model over an org and assemble the proposed workflow. Pairs
 * each org issue with the model's note (by index; falls back to the raw detail).
 */
export const deriveWorkflow = async (
  model: ProposalModel,
  org: OrgChart,
): Promise<OnboardingResult> => {
  const proposal = await model.propose(org);
  const workflow = assembleWorkflow(org, proposal);
  const issues = org.issues.map((iss, i) => ({
    employeeName: iss.employeeName,
    detail: iss.detail,
    note: proposal.issueNotes[i] ?? iss.detail,
  }));
  return { workflow, proposal, issues };
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  The prompt + a parser for a raw structured-output string
 * ────────────────────────────────────────────────────────────────────────── */

/** Compact view of the org handed to the model — titles + reporting, no noise. */
export const orgForPrompt = (org: OrgChart): string => {
  const byId = new Map(org.employees.map((e) => [e.id, e]));
  const people = org.employees
    .map((e) => {
      const mgr = e.managerId ? (byId.get(e.managerId)?.name ?? "?") : "—";
      return `- ${e.name} | ${e.title || "(no title)"} | dept: ${e.department || "?"} | manager: ${mgr}`;
    })
    .join("\n");
  const issues = org.issues.length
    ? org.issues.map((i) => `- [${i.kind}] ${i.detail}`).join("\n")
    : "- (none)";
  return `EMPLOYEES (${org.employees.length}):\n${people}\n\nDATA-QUALITY ISSUES (${org.issues.length}):\n${issues}`;
};

/** The instruction handed to the structured-output model. */
export const ONBOARDING_SYSTEM_PROMPT = `You configure procure-to-pay approval workflows from a company's org chart. Given the employees (title, department, reporting line) and any data-quality issues, you make ONLY the judgement calls a deterministic template can't:

1. Fill three approval roles with the right TITLE from this org, and resolve each to a real PERSON:
   - "manager": the front-line approver an invoice first goes to.
   - "director": the senior approver for larger amounts. Pick a genuinely more senior title than the manager (e.g. a VP or C-level), resolved to a real person.
   - "department-head": who reviews department-specific (e.g. Product) purchases.
   For each, give the title, the person's exact name from the org (or null if no one fits), and a one-line rationale. If you cannot find a sensible person, set the name to null — do not invent one.

2. Propose "directorThreshold": the invoice amount above which the director must also approve. Choose a sensible round number for a company this size.

3. For EACH data-quality issue shown, in the same order, write one plain-language sentence telling the reviewer what to check or fix.

4. Write a short "summary" of the proposed workflow for the reviewer.

Return ONLY the JSON object matching the schema. Never invent people who aren't in the org.`;

/**
 * The prompt body for one org (system prompt is separate). Exposed so the eval and
 * the workflow step build the request identically.
 */
export const onboardingPrompt = (org: OrgChart): string => {
  return `Here is the org to configure an approval workflow for:\n\n${orgForPrompt(org)}\n\nProduce the JSON proposal.`;
};

/** Validate a raw model JSON value into an OnboardingProposal (or throw). */
export const parseProposal = (raw: unknown): TProposal => {
  return OnboardingProposal.parse(raw);
};
