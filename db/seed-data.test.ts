import { test } from "node:test";
import assert from "node:assert/strict";
import { SEED_BUNDLES, type SeedBundle } from "./seed-data";
import { Invoice, PurchaseOrder, GoodsReceipt } from "@/lib/schema";
import { runMatch } from "@/lib/matching";
import { routeApproval } from "@/lib/policy";

/**
 * The seed dataset IS the demo scenario, so it's tested like one. These run the
 * real matcher + policy over every seeded bundle and assert each lands on the
 * verdict/tier the on-stage walkthrough depends on. If a future tweak to the
 * data or the rules would make the "price mismatch" invoice quietly pass, this
 * fails in CI before it ever reaches a sales call. Pure (no DB, no LLM).
 */

// Reconstruct the duplicate-detection ledger exactly the way the DB read layer
// does: order-aware. An invoice number counts as "prior" for a given row only if
// an EARLIER row (lower seed index = earlier createdAt) already carried it — so
// the first occurrence is clean and a later re-send is the duplicate.
function ledgerFor(bundle: SeedBundle): string[] {
  const idx = SEED_BUNDLES.indexOf(bundle);
  return SEED_BUNDLES.slice(0, idx).map((b) => b.invoice.invoiceNumber);
}

function matchOf(bundle: SeedBundle) {
  return runMatch({
    invoice: bundle.invoice,
    purchaseOrder: bundle.purchaseOrder ?? null,
    goodsReceipt: bundle.goodsReceipt ?? null,
    priorInvoiceNumbers: ledgerFor(bundle),
  });
}

const byId = (id: string): SeedBundle => {
  const b = SEED_BUNDLES.find((x) => x.id === id);
  assert.ok(b, `seed bundle ${id} should exist`);
  return b;
};

test("every seeded document validates against the Zod schema", () => {
  for (const b of SEED_BUNDLES) {
    assert.doesNotThrow(() => Invoice.parse(b.invoice), `${b.id} invoice`);
    if (b.purchaseOrder) {
      assert.doesNotThrow(() => PurchaseOrder.parse(b.purchaseOrder), `${b.id} PO`);
    }
    if (b.goodsReceipt) {
      assert.doesNotThrow(() => GoodsReceipt.parse(b.goodsReceipt), `${b.id} GR`);
    }
  }
});

test("the three headline edge cases produce their intended verdicts", () => {
  assert.equal(matchOf(byId("INV-2042")).verdict, "exception", "price mismatch");
  assert.equal(matchOf(byId("INV-2048")).verdict, "exception", "quantity mismatch");
  assert.equal(matchOf(byId("INV-2041-RESEND")).verdict, "duplicate", "duplicate");
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
  assert.ok(codes.includes("qty_variance_receipt"), "receipt overbill must fire");
  assert.ok(!codes.includes("qty_variance_po"), "PO qty agrees (ordered = invoiced)");
  assert.equal(m.matchType, "three_way");
});

test("the original of the duplicate pair is itself clean", () => {
  // INV-2041 (the first occurrence) only becomes a problem on the RE-SEND.
  assert.equal(matchOf(byId("INV-2041")).verdict, "clean");
});

test("clean bundles route to auto-approval (straight-through)", () => {
  for (const id of ["INV-2040", "INV-2044", "INV-2047", "INV-2049", "INV-2043"]) {
    const decision = routeApproval(matchOf(byId(id)));
    assert.equal(decision.tier, "auto", `${id} should be auto-approved`);
  }
});

test("the services invoice is a clean 2-way match (no receipt)", () => {
  const m = matchOf(byId("INV-2043"));
  assert.equal(m.matchType, "two_way");
  assert.equal(m.verdict, "clean");
});

test("exceptions route to a human tier; the duplicate is blocked", () => {
  assert.notEqual(routeApproval(matchOf(byId("INV-2042"))).tier, "auto");
  assert.notEqual(routeApproval(matchOf(byId("INV-2045"))).tier, "auto"); // arithmetic
  assert.notEqual(routeApproval(matchOf(byId("INV-2046"))).tier, "auto"); // off-PO
  assert.equal(routeApproval(matchOf(byId("INV-2041-RESEND"))).tier, "blocked");
});

test("the queue is a healthy mix: majority clean, with each edge case present", () => {
  const verdicts = SEED_BUNDLES.map((b) => matchOf(b).verdict);
  const clean = verdicts.filter((v) => v === "clean").length;
  const exception = verdicts.filter((v) => v === "exception").length;
  const duplicate = verdicts.filter((v) => v === "duplicate").length;
  assert.ok(clean >= 5, "most invoices should be clean so the exceptions stand out");
  assert.ok(exception >= 3, "several exceptions to demo the routing");
  assert.equal(duplicate, 1, "exactly one duplicate");
});
