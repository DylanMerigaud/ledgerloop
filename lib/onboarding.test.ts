import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApprovalWorkflow,
  evaluateCondition,
  type OnboardingProposal,
  type InvoiceContext,
} from "@/lib/approval-workflow";
import {
  assembleWorkflow,
  deriveWorkflow,
  orgForPrompt,
  type ProposalModel,
} from "@/lib/onboarding";
import type { OrgChart } from "@/lib/schema";

/**
 * The deterministic assembly is the part that must be exact: given the model's
 * fuzzy proposal, the DAG it produces is fixed and valid. The model call itself is
 * exercised via an injected fake (the real one is integration-tested live).
 */

const org: OrgChart = {
  source: "test-co",
  employees: [
    {
      id: "1",
      name: "Avery Brooks",
      title: "Founder and CEO",
      department: "Company",
      division: "",
      managerId: null,
    },
    {
      id: "2",
      name: "Jordan Ellis",
      title: "Chief Operating Officer",
      department: "Operations",
      division: "",
      managerId: "1",
    },
    {
      id: "3",
      name: "Esther Howard",
      title: "Sales Director",
      department: "Sales",
      division: "",
      managerId: "2",
    },
  ],
  issues: [
    {
      employeeId: "9",
      employeeName: "Dana Vance",
      kind: "orphan",
      detail: "Dana Vance has no manager and no job title.",
    },
  ],
};

const proposal: OnboardingProposal = {
  directorThreshold: 5000,
  roles: [
    {
      role: "manager",
      title: "Sales Director",
      employeeName: "Esther Howard",
      rationale: "front-line approver",
    },
    {
      role: "director",
      title: "Chief Operating Officer",
      employeeName: "Jordan Ellis",
      rationale: "senior approver",
    },
    {
      role: "department-head",
      title: "VP of IT",
      employeeName: null,
      rationale: "no IT lead in org",
    },
  ],
  issueNotes: ["Dana Vance looks like a junk record — confirm and remove."],
  summary: "Manager → director over $5k → IT review → post.",
};

test("assembled workflow validates and has the template shape", () => {
  const wf = assembleWorkflow(org, proposal);
  assert.doesNotThrow(() => ApprovalWorkflow.parse(wf));
  assert.deepEqual(wf.roots, ["manager-review"]);
  const ids = wf.steps.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    "department-review",
    "director-review",
    "manager-review",
    "post-netsuite",
  ]);
});

test("manager step is unconditional and fans out to the other three", () => {
  const wf = assembleWorkflow(org, proposal);
  const mgr = wf.steps.find((s) => s.id === "manager-review")!;
  assert.equal(mgr.kind, "approval");
  assert.deepEqual([...mgr.next].sort(), [
    "department-review",
    "director-review",
    "post-netsuite",
  ]);
  assert.equal(evaluateCondition(mgr.when, anyCtx()), true); // always
});

test("director step gates on the proposed threshold", () => {
  const wf = assembleWorkflow(org, proposal);
  const dir = wf.steps.find((s) => s.id === "director-review")!;
  assert.equal(evaluateCondition(dir.when, anyCtx({ amount: 6000 })), true);
  assert.equal(evaluateCondition(dir.when, anyCtx({ amount: 4000 })), false);
});

test("resolved approver names flow from the proposal; unresolved stays null", () => {
  const wf = assembleWorkflow(org, proposal);
  const dir = wf.steps.find((s) => s.id === "director-review")!;
  const dept = wf.steps.find((s) => s.id === "department-review")!;
  assert.equal(dir.kind === "approval" && dir.approverName, "Jordan Ellis");
  assert.equal(dept.kind === "approval" && dept.approverName, null); // human to fill
});

test("the final step posts to NetSuite and is a leaf", () => {
  const wf = assembleWorkflow(org, proposal);
  const post = wf.steps.find((s) => s.id === "post-netsuite")!;
  assert.equal(post.kind, "integration");
  assert.equal(post.kind === "integration" && post.integration, "netsuite");
  assert.deepEqual(post.next, []);
});

test("deriveWorkflow runs the model and pairs issues with notes", async () => {
  const fake: ProposalModel = { propose: async () => proposal };
  const result = await deriveWorkflow(fake, org);
  assert.doesNotThrow(() => ApprovalWorkflow.parse(result.workflow));
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.note, /junk record/);
  assert.match(result.issues[0]!.detail, /no manager/);
});

test("orgForPrompt lists people with resolved manager names + issues", () => {
  const s = orgForPrompt(org);
  assert.match(s, /Esther Howard \| Sales Director/);
  assert.match(s, /manager: Jordan Ellis/); // resolved by id → name
  assert.match(s, /\[orphan\]/);
});

// ── helper ───────────────────────────────────────────────────────────────────
const anyCtx = (over: Partial<InvoiceContext> = {}): InvoiceContext => {
  return {
    amount: 1000,
    exceptionAmount: 0,
    variancePct: 0,
    department: "Finance",
    verdict: "clean",
    ...over,
  };
};
