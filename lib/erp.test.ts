import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./erp";
import type { ApprovalDecision, MatchResult } from "./schema";

/**
 * Unit tests for reconciliation — the step that posts to the (fake) ERP, and the
 * second half of the human-in-the-loop gate. These pin the outcome for each
 * approval tier × reviewer decision, which is exactly what the Approve/Reject
 * buttons in the dashboard depend on.
 */

function match(over: Partial<MatchResult> = {}): MatchResult {
  return {
    invoiceNumber: "INV-1",
    poNumber: "PO-1",
    matchType: "three_way",
    verdict: "exception",
    exceptions: [],
    maxVariancePct: 0.09,
    exceptionAmount: 6544,
    currency: "GBP",
    invoiceTotal: 8704,
    ...over,
  };
}

function decision(tier: ApprovalDecision["tier"]): ApprovalDecision {
  return {
    invoiceNumber: "INV-1",
    tier,
    autoApproved: tier === "auto",
    reason: "",
    maxVariancePct: 0.09,
    exceptionAmount: 6544,
    currency: "GBP",
  };
}

test("clean/auto invoice posts immediately (no human needed)", async () => {
  const r = await reconcile(
    decision("auto"),
    match({ verdict: "clean" }),
    "Acme",
  );
  assert.equal(r.outcome, "posted");
  assert.equal(r.posted, true);
  assert.match(r.erpRef ?? "", /NETSUITE-BILL-/);
  assert.ok(r.glEntries.length === 2);
});

test("duplicate is blocked, never posted, regardless of decision", async () => {
  for (const ha of ["pending", "approve", "reject"] as const) {
    const r = await reconcile(
      decision("blocked"),
      match({ verdict: "duplicate" }),
      "Acme",
      ha,
    );
    assert.equal(r.outcome, "blocked");
    assert.equal(r.posted, false);
    assert.equal(r.erpRef, null);
  }
});

test("exception with pending → HELD (awaiting), not posted — the pause", async () => {
  const r = await reconcile(decision("manager"), match(), "Acme", "pending");
  assert.equal(r.outcome, "awaiting");
  assert.equal(r.posted, false);
  assert.equal(r.erpRef, null);
  assert.equal(r.glEntries.length, 0);
});

test("exception with approve → posts to ERP", async () => {
  const r = await reconcile(decision("director"), match(), "Acme", "approve");
  assert.equal(r.outcome, "posted");
  assert.equal(r.posted, true);
  assert.match(r.erpRef ?? "", /NETSUITE-BILL-/);
  assert.equal(r.glEntries.length, 2);
});

test("exception with reject → not posted, outcome rejected", async () => {
  const r = await reconcile(decision("manager"), match(), "Acme", "reject");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.posted, false);
  assert.equal(r.erpRef, null);
});

test("GL entries balance (debit total == credit total) when posted", async () => {
  const r = await reconcile(
    decision("auto"),
    match({ verdict: "clean" }),
    "Acme",
    "approve",
  );
  const debit = r.glEntries.reduce((s, g) => s + g.debit, 0);
  const credit = r.glEntries.reduce((s, g) => s + g.credit, 0);
  assert.equal(debit, credit);
  assert.equal(debit, r.amount);
});
