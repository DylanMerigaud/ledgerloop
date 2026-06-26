import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileFromOutcome } from "@/lib/erp";
import type { MatchResult } from "@/lib/schema";

/**
 * Unit tests for reconciliation — the step that posts to the (fake) ERP, driven
 * by the approval workflow's outcome. These pin what happens for each outcome,
 * which is what the dashboard's posted/awaiting/rejected states depend on. (The
 * outcome itself is decided by the workflow engine, tested in approval-engine.)
 */
const match = (over: Partial<MatchResult> = {}): MatchResult => {
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
    department: "",
    ...over,
  };
};

test("posted outcome → books to the ERP", async () => {
  const r = await reconcileFromOutcome(
    "posted",
    match({ verdict: "clean" }),
    "Acme",
  );
  assert.equal(r.outcome, "posted");
  assert.equal(r.posted, true);
  assert.match(r.erpRef ?? "", /NETSUITE-BILL-/);
  assert.equal(r.glEntries.length, 2);
});

test("blocked outcome (duplicate) → never posted", async () => {
  const r = await reconcileFromOutcome(
    "blocked",
    match({ verdict: "duplicate" }),
    "Acme",
  );
  assert.equal(r.outcome, "blocked");
  assert.equal(r.posted, false);
  assert.equal(r.erpRef, null);
});

test("awaiting outcome → HELD, not posted — the pause", async () => {
  const r = await reconcileFromOutcome("awaiting", match(), "Acme");
  assert.equal(r.outcome, "awaiting");
  assert.equal(r.posted, false);
  assert.equal(r.erpRef, null);
  assert.equal(r.glEntries.length, 0);
});

test("rejected outcome → not posted", async () => {
  const r = await reconcileFromOutcome("rejected", match(), "Acme");
  assert.equal(r.outcome, "rejected");
  assert.equal(r.posted, false);
  assert.equal(r.erpRef, null);
});

test("GL entries balance (debit total == credit total) when posted", async () => {
  const r = await reconcileFromOutcome(
    "posted",
    match({ verdict: "clean" }),
    "Acme",
  );
  const debit = r.glEntries.reduce((s: number, g) => s + g.debit, 0);
  const credit = r.glEntries.reduce((s: number, g) => s + g.credit, 0);
  assert.equal(debit, credit);
  assert.equal(debit, r.amount);
});
