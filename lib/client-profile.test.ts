import assert from "node:assert/strict";
import { test } from "node:test";

import { CLIENT_PROFILES, profileById } from "@/db/client-profiles";
import { runApproval } from "@/lib/approval-run";
import { workflowFromPolicy } from "@/lib/client-profile";
import { runMatch } from "@/lib/matching";
import type { Invoice, PurchaseOrder } from "@/lib/schema";

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

test("the same exception runs each profile's workflow (gate fires either way)", () => {
  // Force an exception by using the strict match (an exception exists).
  const match = runMatch(
    { invoice: INV, purchaseOrder: PO, goodsReceipt: null },
    strict.tolerances,
  );
  assert.equal(match.verdict, "exception");

  // ~30 USD at stake, 3% variance. Both profiles' workflows put it in front of a
  // human (an exception never auto-posts); this proves the per-client workflow is
  // applied, derived from each profile's policy.
  const strictRun = runApproval(
    workflowFromPolicy(strict.approvalPolicy),
    match,
  );
  const relaxedRun = runApproval(
    workflowFromPolicy(relaxed.approvalPolicy),
    match,
  );
  assert.equal(strictRun.outcome, "awaiting");
  assert.equal(relaxedRun.outcome, "awaiting");
  assert.ok(strictRun.pending.some((p) => p.id === "manager-review"));
  assert.ok(relaxedRun.pending.some((p) => p.id === "manager-review"));
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
