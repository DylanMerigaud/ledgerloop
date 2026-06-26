import assert from "node:assert/strict";
import { test } from "node:test";

import { type MatchTolerances } from "@/lib/client-profile";
import { runMatch } from "@/lib/matching";
import type { Invoice, PurchaseOrder } from "@/lib/schema";

/**
 * The config-driven claim, at the tolerance layer: the SAME invoice gets a
 * different verdict depending on the client's matching tolerances. (The approval
 * side of "config, not code" — how a policy becomes a gating DAG — is covered in
 * workflow-from-policy.test.ts.)
 */

// An invoice 3% over the PO on one line. Small money, small variance.
const PO: PurchaseOrder = {
  poNumber: "PO-1",
  vendor: "Acme",
  currency: "USD",
  lineItems: [
    { sku: "A", description: "Widget", qty: 10, unitPrice: 100, amount: 1000 },
  ],
  total: 1000,
  department: "",
};
const INV: Invoice = {
  invoiceNumber: "INV-1",
  poNumber: "PO-1",
  vendor: "Acme",
  issueDate: "2026-05-01",
  currency: "USD",
  // 103 vs 100 = 3% over.
  lineItems: [
    { sku: "A", description: "Widget", qty: 10, unitPrice: 103, amount: 1030 },
  ],
  subtotal: 1030,
  tax: null,
  total: 1030,
};

const strict: MatchTolerances = {
  pricePct: 0.005,
  lineAmountAbs: 0.01,
  qtyAbs: 0,
};
const relaxed: MatchTolerances = {
  pricePct: 0.05,
  lineAmountAbs: 0.5,
  qtyAbs: 0,
};

test("a 3% overage is an exception under tight tolerances, clean under loose", () => {
  const strictMatch = runMatch(
    { invoice: INV, purchaseOrder: PO, goodsReceipt: null },
    strict,
  );
  const relaxedMatch = runMatch(
    { invoice: INV, purchaseOrder: PO, goodsReceipt: null },
    relaxed,
  );
  // strict: 0.5% tolerance → 3% is a price variance → exception.
  assert.equal(strictMatch.verdict, "exception");
  // relaxed: 5% tolerance → 3% is within noise → clean.
  assert.equal(relaxedMatch.verdict, "clean");
});
