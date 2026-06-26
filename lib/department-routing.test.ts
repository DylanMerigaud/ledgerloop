import assert from "node:assert/strict";
import { test } from "node:test";

import { runApproval } from "@/lib/approval-run";
import { type OnboardingProposal } from "@/lib/approval-workflow";
import { runMatch } from "@/lib/matching";
import { assembleWorkflow } from "@/lib/onboarding";
import type { Invoice, PurchaseOrder, OrgChart } from "@/lib/schema";

/**
 * The department lever, end to end: a buying department lives on the PO, flows
 * through matching into the MatchResult, and the engine routes a derived workflow's
 * "department review" gate on it. This guards the chain that used to be dead — the
 * engine hardcoded department: "" so a department gate could never fire.
 */

const lines = [
  {
    sku: "BOX-12",
    description: "Shipping box (pack/25)",
    qty: 10,
    unitPrice: 8,
    amount: 80,
  },
];
const PO = (department: string): PurchaseOrder => ({
  poNumber: "PO-9001",
  vendor: "Meridian Packaging",
  currency: "USD",
  lineItems: lines,
  total: 80,
  department,
});
const INV: Invoice = {
  invoiceNumber: "INV-9001",
  poNumber: "PO-9001",
  vendor: "Meridian Packaging",
  issueDate: "2026-05-10",
  currency: "USD",
  lineItems: lines,
  subtotal: 80,
  tax: null,
  total: 80,
};

// A tiny org + proposal so the DERIVED workflow (not a hand-built one) is what
// routes — the gate is `department == "Product"` per the template.
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
      name: "Sam Patel",
      title: "VP of Product",
      department: "Product",
      division: "",
      managerId: "1",
    },
  ],
  issues: [],
};
const proposal: OnboardingProposal = {
  directorThreshold: 5000,
  roles: [
    {
      role: "manager",
      title: "Founder and CEO",
      employeeName: "Avery Brooks",
      rationale: "front-line",
    },
    {
      role: "director",
      title: "Founder and CEO",
      employeeName: "Avery Brooks",
      rationale: "senior",
    },
    {
      role: "department-head",
      title: "VP of Product",
      employeeName: "Sam Patel",
      rationale: "product lead",
    },
  ],
  issueNotes: [],
  summary: "manager → director over $5k → Product review → post",
};

test("a PO's department flows through matching into the MatchResult", () => {
  const match = runMatch({
    invoice: INV,
    purchaseOrder: PO("Product"),
    goodsReceipt: null,
  });
  assert.equal(match.verdict, "clean"); // amounts agree → clean
  assert.equal(match.department, "Product");

  const none = runMatch({
    invoice: INV,
    purchaseOrder: PO(""),
    goodsReceipt: null,
  });
  assert.equal(none.department, "");
});

test("the derived department gate fires for its department, even on a CLEAN invoice", () => {
  const wf = assembleWorkflow(org, proposal);
  const match = runMatch({
    invoice: INV,
    purchaseOrder: PO("Product"),
    goodsReceipt: null,
  });
  // Department head is a parallel root, so on a Product invoice it pends in the SAME
  // first wave as the manager — one approval round clears both (no second pause).
  // A clean invoice does NOT straight-through when its department is gated.
  const run = runApproval(wf, match);
  assert.equal(run.outcome, "awaiting");
  const pendingIds = run.pending.map((p) => p.id).sort();
  assert.deepEqual(
    pendingIds,
    ["department-review", "manager-review"],
    "manager + Product department gate pend together in one wave",
  );
});

test("the same workflow skips the department gate when the PO has no department", () => {
  const wf = assembleWorkflow(org, proposal);
  const match = runMatch({
    invoice: INV,
    purchaseOrder: PO(""),
    goodsReceipt: null,
  });
  // No department → the gate's condition is false → it skips (a root that passes
  // through). With the manager approved and the $80 invoice under the director
  // threshold, every gate clears and the bill posts — so the department root isn't a
  // phantom blocker when the PO has no department.
  const run = runApproval(wf, match, { "manager-review": "approve" });
  assert.equal(run.outcome, "posted");
  const dept = run.state.steps.find((s) => s.id === "department-review");
  assert.equal(dept?.status, "skipped");
});
