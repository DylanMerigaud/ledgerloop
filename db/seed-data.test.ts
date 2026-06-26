import assert from "node:assert/strict";
import { test } from "node:test";

import { SEED_BUNDLES, type SeedBundle } from "@/db/seed-data";
import { runApproval } from "@/lib/approval-run";
import type { ApprovalWorkflow } from "@/lib/approval-workflow";
import {
  workflowFromPolicy,
  DEFAULT_APPROVAL_POLICY,
} from "@/lib/client-profile";
import { runMatch } from "@/lib/matching";
import { Invoice, PurchaseOrder, GoodsReceipt } from "@/lib/schema";

const WORKFLOW = workflowFromPolicy(DEFAULT_APPROVAL_POLICY);

/**
 * The seed dataset IS the demo scenario, so it's tested like one. These run the
 * real matcher + approval workflow over every seeded bundle and assert each lands
 * on the verdict/routing the on-stage walkthrough depends on. If a future tweak to
 * the data or the rules would make the "price mismatch" invoice quietly pass, this
 * fails in CI before it ever reaches a sales call. Pure (no DB, no LLM).
 */
const ledgerFor = (bundle: SeedBundle): string[] => {
  const idx = SEED_BUNDLES.indexOf(bundle);
  return SEED_BUNDLES.slice(0, idx).map((b) => b.invoice.invoiceNumber);
};

const matchOf = (bundle: SeedBundle) => {
  return runMatch({
    invoice: bundle.invoice,
    purchaseOrder: bundle.purchaseOrder ?? null,
    goodsReceipt: bundle.goodsReceipt ?? null,
    priorInvoiceNumbers: ledgerFor(bundle),
  });
};

const byId = (id: string): SeedBundle => {
  const b = SEED_BUNDLES.find((x) => x.id === id);
  assert.ok(b, `seed bundle ${id} should exist`);
  return b;
};

test("the demo's department POs carry their buying department", () => {
  // Three distinct departments are seeded so a department-scoped gate is demonstrable
  // (and each maps to a real org head). If a future edit drops one, the
  // "route by department" demo would quietly stop firing.
  const dept = (id: string) => byId(id).purchaseOrder?.department;
  assert.equal(dept("INV-2044"), "Product"); // PO-7744
  assert.equal(dept("INV-2042"), "Operations"); // PO-7742
  assert.equal(dept("INV-2047"), "Finance"); // PO-7747
});

test("every seeded document validates against the Zod schema", () => {
  for (const b of SEED_BUNDLES) {
    assert.doesNotThrow(() => Invoice.parse(b.invoice), `${b.id} invoice`);
    if (b.purchaseOrder) {
      assert.doesNotThrow(
        () => PurchaseOrder.parse(b.purchaseOrder),
        `${b.id} PO`,
      );
    }
    if (b.goodsReceipt) {
      assert.doesNotThrow(
        () => GoodsReceipt.parse(b.goodsReceipt),
        `${b.id} GR`,
      );
    }
  }
});

test("the three headline edge cases produce their intended verdicts", () => {
  assert.equal(
    matchOf(byId("INV-2042")).verdict,
    "exception",
    "price mismatch",
  );
  assert.equal(
    matchOf(byId("INV-2048")).verdict,
    "exception",
    "quantity mismatch",
  );
  assert.equal(
    matchOf(byId("INV-2041-RESEND")).verdict,
    "duplicate",
    "duplicate",
  );
});

test("price mismatch is a price_variance on the steel-bar line", () => {
  const m = matchOf(byId("INV-2042"));
  const codes = m.exceptions.map((e) => e.code);
  assert.ok(codes.includes("price_variance"));
  assert.ok(m.maxVariancePct > 0.01, "variance must clear the 1% tolerance");
});

test("quantity mismatch is caught by the 3-way receipt check, not the PO check", () => {
  const m = matchOf(byId("INV-2048"));
  const codes = m.exceptions.map((e) => e.code);
  assert.ok(
    codes.includes("qty_variance_receipt"),
    "receipt overbill must fire",
  );
  assert.ok(
    !codes.includes("qty_variance_po"),
    "PO qty agrees (ordered = invoiced)",
  );
  assert.equal(m.matchType, "three_way");
});

test("the original of the duplicate pair is itself clean", () => {
  // INV-2041 (the first occurrence) only becomes a problem on the RE-SEND.
  assert.equal(matchOf(byId("INV-2041")).verdict, "clean");
});

test("a small clean invoice routes straight through (under the manager floor)", () => {
  // INV-2040 is a $730 clean 3-way match — below the $1,000 manager floor, so no
  // gate fires and it posts with no human (the straight-through automation win).
  const run = runApproval(WORKFLOW, matchOf(byId("INV-2040")));
  assert.equal(run.outcome, "posted");
  assert.equal(run.pending.length, 0);
});

test("a material clean invoice still needs the manager (over the floor)", () => {
  // Clean but over $1,000 → a human signs a material bill even on a perfect match,
  // the standard AP control. (INV-2049 $9,360, INV-2043 $16,080, etc.)
  for (const id of ["INV-2044", "INV-2047", "INV-2049", "INV-2043"]) {
    const run = runApproval(WORKFLOW, matchOf(byId(id)));
    assert.equal(matchOf(byId(id)).verdict, "clean", `${id} is clean`);
    assert.equal(run.outcome, "awaiting", `${id} should need approval`);
    assert.ok(
      run.pending.some((p) => p.id === "manager-review"),
      `${id} should pend the manager gate`,
    );
  }
});

// A parallel-root workflow like the one onboarding derives: manager review fires on
// any exception, department review fires on the Product department — two ROOTS that
// can pend at once. (The default policy workflow has a single root, so it can't
// surface this; this mirrors the derived shape just enough to pin the data premise.)
const PARALLEL_WORKFLOW: ApprovalWorkflow = {
  name: "Parallel gates",
  roots: ["manager-review", "department-review"],
  steps: [
    {
      id: "manager-review",
      kind: "approval",
      label: "Manager review",
      when: { kind: "leaf", field: "verdict", op: "==", value: "exception" },
      approverTitle: "Manager",
      approverName: "Esther Howard",
      next: ["post"],
    },
    {
      id: "department-review",
      kind: "approval",
      label: "Department review",
      when: { kind: "leaf", field: "department", op: "==", value: "Product" },
      approverTitle: "Head of Product",
      approverName: "Sam Patel",
      next: ["post"],
    },
    {
      id: "post",
      kind: "integration",
      label: "Post the bill",
      when: { kind: "always" },
      integration: "netsuite",
      next: [],
    },
  ],
};

test("INV-2051 pends BOTH parallel gates (exception + Product) in one wave", () => {
  // The invoice that demonstrates per-gate decisions: it's an exception (manager
  // gate) AND department Product (department gate), so both roots pend together.
  const m = matchOf(byId("INV-2051"));
  assert.equal(m.verdict, "exception", "INV-2051 is a price exception");
  assert.equal(m.department, "Product", "INV-2051 is a Product PO");

  const run = runApproval(PARALLEL_WORKFLOW, m);
  assert.equal(run.outcome, "awaiting");
  const pendingIds = run.pending.map((p) => p.id).sort();
  assert.deepEqual(pendingIds, ["department-review", "manager-review"]);
});

test("mixed parallel decision: rejecting one gate blocks the bill", () => {
  // Approve the department gate but reject the manager gate → the bill does NOT post
  // (reject wins). This is the whole point of per-gate decisions.
  const m = matchOf(byId("INV-2051"));
  const run = runApproval(PARALLEL_WORKFLOW, m, {
    "manager-review": "reject",
    "department-review": "approve",
  });
  assert.equal(run.outcome, "rejected");
  assert.ok(
    !run.pending.length,
    "no gate is left pending once both are decided",
  );
});

test("the services invoice is a clean 2-way match (no receipt)", () => {
  const m = matchOf(byId("INV-2043"));
  assert.equal(m.matchType, "two_way");
  assert.equal(m.verdict, "clean");
});

test("exceptions need a human gate; the duplicate is a (pre-workflow) block", () => {
  // An exception pauses with at least one pending approval gate.
  for (const id of ["INV-2042", "INV-2045", "INV-2046"]) {
    const run = runApproval(WORKFLOW, matchOf(byId(id)));
    assert.equal(run.outcome, "awaiting", `${id} should await approval`);
    assert.ok(run.pending.length >= 1, `${id} should have a pending gate`);
  }
  // The duplicate is a control failure caught at matching — never routed.
  assert.equal(matchOf(byId("INV-2041-RESEND")).verdict, "duplicate");
});

test("the queue is a healthy mix: majority clean, with each edge case present", () => {
  const verdicts = SEED_BUNDLES.map((b) => matchOf(b).verdict);
  const clean = verdicts.filter((v) => v === "clean").length;
  const exception = verdicts.filter((v) => v === "exception").length;
  const duplicate = verdicts.filter((v) => v === "duplicate").length;
  assert.ok(
    clean >= 5,
    "most invoices should be clean so the exceptions stand out",
  );
  assert.ok(exception >= 3, "several exceptions to demo the routing");
  assert.equal(duplicate, 1, "exactly one duplicate");
});
