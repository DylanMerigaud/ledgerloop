import {
  type ApprovalWorkflow,
  type WorkflowStep,
  type ApprovalStep,
  type Condition,
  approversOf,
} from "@/lib/approval-workflow";

/**
 * Workflow validation — does this approval workflow make sense?
 *
 * Two kinds of checks, both PURE and deterministic (no model, no I/O — so it's
 * exhaustively testable and safe to run on every edit, and it can be the tool an
 * editing agent corrects against):
 *
 *   • STRUCTURAL — the graph is sound: it's a DAG, every step is reachable, it ends
 *     in a posting step, no dangling edges.
 *   • AP BEST-PRACTICE — it's a *good* approval workflow per accounts-payable
 *     controls: segregation of duties (no one approves twice on a path), a second
 *     approver on high-value spend, at least one human gate before posting, no
 *     duplicate/contradictory gates, every approver resolved to a real person.
 *
 * Errors mean the workflow is broken (it won't run / can't post) — the UI blocks
 * "Approve" on a proposal with errors. Warnings mean it runs but violates a control
 * best-practice — surfaced prominently, not blocking. Zero of both = "Sound".
 *
 * Sources for the AP rules: ApprovalMax AP-controls, Ramp segregation-of-duties.
 */

export type WorkflowIssue = {
  severity: "error" | "warning";
  /** Stable machine code (for tests + the agent's correction signal). */
  code: string;
  /** Human-readable, shown in the UI and fed back to the editing agent. */
  message: string;
  /** Steps the issue concerns, for highlighting on the canvas. */
  stepIds: string[];
};

/** Spend above this (in a path's amount gate) is "high value" → wants 2 approvers. */
export const MATERIALITY = 25000;

export const validateWorkflow = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  return [
    ...danglingEdges(wf),
    ...rootsValid(wf),
    ...cycleFree(wf),
    ...allReachable(wf),
    ...postReached(wf),
    ...unresolvedApprovers(wf),
    ...duplicateGates(wf),
    ...segregationOfDuties(wf),
    ...highValueSecondApprover(wf),
    ...humanBeforePost(wf),
  ];
};

/** True when the workflow has no errors (warnings are allowed). */
export const isActivatable = (issues: WorkflowIssue[]): boolean =>
  !issues.some((i) => i.severity === "error");

/* ── condition helpers ──────────────────────────────────────────────────────── */

/** Flatten a condition tree into its leaves (ignores all/any structure). */
const leaves = (c: Condition): Extract<Condition, { kind: "leaf" }>[] => {
  if (c.kind === "leaf") return [c];
  if (c.kind === "all" || c.kind === "any") return c.conditions.flatMap(leaves);
  return [];
};

/** The amount lower-bound a step requires (from a `>`/`>=` amount leaf), or null. */
const amountFloor = (step: WorkflowStep): number | null => {
  const amt = leaves(step.when).find(
    (l) => l.field === "amount" && (l.op === ">" || l.op === ">="),
  );
  return amt && typeof amt.value === "number" ? amt.value : null;
};

/** The department a step is scoped to (from a `department ==` leaf), or null. */
const departmentScope = (step: WorkflowStep): string | null => {
  const dep = leaves(step.when).find(
    (l) => l.field === "department" && l.op === "==",
  );
  return dep && typeof dep.value === "string" ? dep.value : null;
};

const approvals = (wf: ApprovalWorkflow): ApprovalStep[] =>
  wf.steps.filter((s): s is ApprovalStep => s.kind === "approval");

/* ── graph helpers ──────────────────────────────────────────────────────────── */

const successors = (wf: ApprovalWorkflow): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const s of wf.steps) m.set(s.id, s.next);
  return m;
};

/** All step ids reachable from the roots (BFS). */
const reachableFromRoots = (wf: ApprovalWorkflow): Set<string> => {
  const succ = successors(wf);
  const seen = new Set<string>();
  const queue = [...wf.roots];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of succ.get(id) ?? []) queue.push(n);
  }
  return seen;
};

/** Every root-to-post path as an ordered list of step ids (DAG, small graphs). */
const pathsToPosts = (wf: ApprovalWorkflow): string[][] => {
  const succ = successors(wf);
  const isPost = (id: string): boolean => {
    const s = wf.steps.find((x) => x.id === id);
    return !!s && s.kind === "integration" && s.next.length === 0;
  };
  const out: string[][] = [];
  const walk = (id: string, trail: string[]): void => {
    if (trail.includes(id)) return; // cycle guard (cycles reported separately)
    const next = [...trail, id];
    const kids = succ.get(id) ?? [];
    if (isPost(id) || kids.length === 0) {
      out.push(next);
      return;
    }
    for (const k of kids) walk(k, next);
  };
  for (const r of wf.roots) walk(r, []);
  return out;
};

/* ── structural checks ──────────────────────────────────────────────────────── */

const danglingEdges = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const ids = new Set(wf.steps.map((s) => s.id));
  const bad = wf.steps.flatMap((s) =>
    s.next.filter((n) => !ids.has(n)).map((n) => ({ from: s.id, to: n })),
  );
  return bad.map((b) => ({
    severity: "error",
    code: "dangling-edge",
    message: `"${b.from}" points to a step that doesn't exist ("${b.to}").`,
    stepIds: [b.from],
  }));
};

const rootsValid = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const ids = new Set(wf.steps.map((s) => s.id));
  if (wf.roots.length === 0)
    return [
      {
        severity: "error",
        code: "no-roots",
        message: "The workflow has no entry point (no roots).",
        stepIds: [],
      },
    ];
  return wf.roots
    .filter((r) => !ids.has(r))
    .map((r) => ({
      severity: "error" as const,
      code: "no-roots",
      message: `Root "${r}" is not a real step.`,
      stepIds: [],
    }));
};

const cycleFree = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  // Kahn: if not all nodes get emitted, there's a cycle.
  const indeg = new Map(wf.steps.map((s) => [s.id, 0]));
  for (const s of wf.steps)
    for (const n of s.next) indeg.set(n, (indeg.get(n) ?? 0) + 1);
  const queue = [...indeg.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  let emitted = 0;
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    emitted++;
    for (const n of byId.get(id)?.next ?? []) {
      const d = (indeg.get(n) ?? 0) - 1;
      indeg.set(n, d);
      if (d === 0) queue.push(n);
    }
  }
  if (emitted === wf.steps.length) return [];
  return [
    {
      severity: "error",
      code: "cycle",
      message: "The workflow has a cycle — approvals must flow one way.",
      stepIds: [],
    },
  ];
};

const allReachable = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const seen = reachableFromRoots(wf);
  return wf.steps
    .filter((s) => !seen.has(s.id))
    .map((s) => ({
      severity: "error" as const,
      code: "unreachable-step",
      message: `"${s.label}" can't be reached from the start.`,
      stepIds: [s.id],
    }));
};

const postReached = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const posts = wf.steps.filter(
    (s) => s.kind === "integration" && s.next.length === 0,
  );
  if (posts.length === 0)
    return [
      {
        severity: "error",
        code: "no-post",
        message: "Nothing posts the bill — add a final NetSuite step.",
        stepIds: [],
      },
    ];
  const seen = reachableFromRoots(wf);
  return posts.some((p) => seen.has(p.id))
    ? []
    : [
        {
          severity: "error",
          code: "post-not-reached",
          message: "The posting step can't be reached from the start.",
          stepIds: posts.map((p) => p.id),
        },
      ];
};

/* ── AP best-practice checks ────────────────────────────────────────────────── */

const unresolvedApprovers = (wf: ApprovalWorkflow): WorkflowIssue[] =>
  approvals(wf)
    .filter((s) => s.approverName === null)
    .map((s) => ({
      severity: "warning",
      code: "unresolved-approver",
      message: `"${s.label}" has no person assigned — resolve the ${s.approverTitle} before activating.`,
      stepIds: [s.id],
    }));

const duplicateGates = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const out: WorkflowIssue[] = [];
  const gates = approvals(wf);
  for (let i = 0; i < gates.length; i++) {
    for (let j = i + 1; j < gates.length; j++) {
      const a = gates[i];
      const b = gates[j];
      if (!a || !b) continue;
      const sameDept = departmentScope(a) === departmentScope(b);
      const sameRole = a.approverTitle === b.approverTitle;
      if (sameRole && sameDept) {
        out.push({
          severity: "warning",
          code: "duplicate-gate",
          message: `"${a.label}" and "${b.label}" overlap (same role and scope) — merge them or narrow one.`,
          stepIds: [a.id, b.id],
        });
      }
    }
  }
  return out;
};

const segregationOfDuties = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const out: WorkflowIssue[] = [];
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  for (const path of pathsToPosts(wf)) {
    const seen = new Map<string, string>(); // person → first step label
    for (const id of path) {
      const s = byId.get(id);
      if (!s || s.kind !== "approval") continue;
      // Every approver on the gate counts — a co-approver who already signed an
      // earlier gate on this path breaks segregation just as a primary would.
      for (const person of approversOf(s)) {
        const prev = seen.get(person);
        if (prev) {
          out.push({
            severity: "warning",
            code: "segregation-of-duties",
            message: `${person} approves more than once on the same path ("${prev}" and "${s.label}") — a second person should sign off.`,
            stepIds: [id],
          });
        } else {
          seen.set(person, s.label);
        }
      }
    }
  }
  return dedupe(out);
};

const highValueSecondApprover = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const out: WorkflowIssue[] = [];
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  for (const path of pathsToPosts(wf)) {
    // The highest amount-floor any gate on this path enforces.
    const floors = path
      .map((id) => byId.get(id))
      .filter((s): s is WorkflowStep => !!s)
      .map((s) => amountFloor(s) ?? 0);
    const pathFloor = Math.max(0, ...floors);
    if (pathFloor < MATERIALITY) continue; // not a high-value path
    const humanGates = path
      .map((id) => byId.get(id))
      .filter((s): s is ApprovalStep => !!s && s.kind === "approval").length;
    if (humanGates < 2) {
      out.push({
        severity: "warning",
        code: "single-approver-high-value",
        message: `Bills over $${pathFloor.toLocaleString("en-US")} clear with only one approval — high-value spend should need a second approver.`,
        stepIds: path.filter((id) => byId.get(id)?.kind === "approval"),
      });
    }
  }
  return dedupe(out);
};

const humanBeforePost = (wf: ApprovalWorkflow): WorkflowIssue[] => {
  const byId = new Map(wf.steps.map((s) => [s.id, s]));
  const offenders: string[][] = [];
  for (const path of pathsToPosts(wf)) {
    const hasHuman = path.some((id) => byId.get(id)?.kind === "approval");
    if (!hasHuman) offenders.push(path);
  }
  if (offenders.length === 0) return [];
  return [
    {
      severity: "warning",
      code: "no-human-approval",
      message:
        "A bill can post with no human approval — add at least one approval gate before posting.",
      stepIds: [],
    },
  ];
};

/** Drop issues with the same code+message (paths can re-surface the same one). */
const dedupe = (issues: WorkflowIssue[]): WorkflowIssue[] => {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.code}:${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
