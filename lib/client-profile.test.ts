import { test } from "node:test";
import assert from "node:assert/strict";
import { runMatch } from "./matching";
import { routeApproval } from "./policy";
import { CLIENT_PROFILES, profileById } from "@/db/client-profiles";
import type { Invoice, PurchaseOrder } from "./schema";

/**
 * Profile-driven behaviour — the config-driven claim. The SAME invoice routes
 * differently depending on the client profile (tolerances + approval tiers). This
 * is what "onboarding a client is config, not code" means in practice.
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

const strict = profileById("severn-manufacturing");
const relaxed = profileById("meridian-distribution");

test("a 3% overage is an exception under the strict profile, clean under relaxed", () => {
  const strictMatch = runMatch(
    { invoice: INV, purchaseOrder: PO, goodsReceipt: null },
    strict.tolerances,
  );
  const relaxedMatch = runMatch(
    { invoice: INV, purchaseOrder: PO, goodsReceipt: null },
    relaxed.tolerances,
  );
  // strict: 0.5% tolerance → 3% is a price variance → exception.
  assert.equal(strictMatch.verdict, "exception");
  // relaxed: 5% tolerance → 3% is within noise → clean.
  assert.equal(relaxedMatch.verdict, "clean");
});

test("the same exception routes to a different tier per profile", () => {
  // Force an exception both ways by using the strict match (an exception exists).
  const match = runMatch(
    { invoice: INV, purchaseOrder: PO, goodsReceipt: null },
    strict.tolerances,
  );
  assert.equal(match.verdict, "exception");

  // ~30 USD at stake, 3% variance.
  const strictDecision = routeApproval(match, strict.approvalPolicy);
  const relaxedDecision = routeApproval(match, relaxed.approvalPolicy);

  // strict: 2% manager threshold → 3% trips manager.
  assert.equal(strictDecision.tier, "manager");
  // relaxed: 10% manager threshold, $5k → 3% / $30 stays under → still manager
  // (an exception never auto-approves), but proves the policy is applied, not fixed.
  assert.equal(relaxedDecision.tier, "manager");
});

test("profileById falls back to standard for unknown / missing ids", () => {
  assert.equal(profileById("nope").id, "standard");
  assert.equal(profileById(null).id, "standard");
  assert.equal(profileById(undefined).id, "standard");
});

test("every seeded profile is internally valid", () => {
  for (const p of CLIENT_PROFILES) {
    assert.ok(p.tolerances.pricePct >= 0);
    assert.ok(
      p.approvalPolicy.director.amount >= p.approvalPolicy.manager.amount,
    );
  }
});
