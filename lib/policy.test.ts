import { test } from "node:test";
import assert from "node:assert/strict";
import { routeApproval } from "./policy";
import type { MatchResult } from "./schema";

/**
 * Unit tests for the approval-routing policy — the business-rule half of the
 * workflow's conditional branching. These pin which tier an invoice lands in,
 * which is exactly what the demo's "caught a mismatch → routed to a human" beat
 * relies on.
 */

function match(over: Partial<MatchResult> = {}): MatchResult {
  return {
    invoiceNumber: "INV-1",
    poNumber: "PO-1",
    matchType: "three_way",
    verdict: "clean",
    exceptions: [],
    maxVariancePct: 0,
    exceptionAmount: 0,
    currency: "USD",
    invoiceTotal: 500,
    ...over,
  };
}

test("clean match → auto-approved, no human", () => {
  const d = routeApproval(match());
  assert.equal(d.tier, "auto");
  assert.equal(d.autoApproved, true);
});

test("duplicate → blocked, never auto-approved", () => {
  const d = routeApproval(
    match({ verdict: "duplicate", exceptionAmount: 500 }),
  );
  assert.equal(d.tier, "blocked");
  assert.equal(d.autoApproved, false);
});

test("small exception → manager tier", () => {
  const d = routeApproval(
    match({
      verdict: "exception",
      maxVariancePct: 0.02,
      exceptionAmount: 200,
      exceptions: [
        {
          sku: "X",
          code: "price_variance",
          message: "",
          variancePct: 0.02,
          invoiceValue: 1,
          expectedValue: 1,
        },
      ],
    }),
  );
  assert.equal(d.tier, "manager");
  assert.equal(d.autoApproved, false);
});

test("variance ≥ 10% → director tier regardless of amount", () => {
  const d = routeApproval(
    match({ verdict: "exception", maxVariancePct: 0.12, exceptionAmount: 300 }),
  );
  assert.equal(d.tier, "director");
});

test("exposure ≥ $10k → director tier regardless of variance", () => {
  const d = routeApproval(
    match({
      verdict: "exception",
      maxVariancePct: 0.02,
      exceptionAmount: 15_000,
    }),
  );
  assert.equal(d.tier, "director");
});

test("exposure ≥ $1k (under $10k) → manager tier", () => {
  const d = routeApproval(
    match({
      verdict: "exception",
      maxVariancePct: 0.02,
      exceptionAmount: 5_000,
    }),
  );
  assert.equal(d.tier, "manager");
});

test("reason mentions the drivers", () => {
  const d = routeApproval(
    match({
      verdict: "exception",
      maxVariancePct: 0.07,
      exceptionAmount: 2_000,
      exceptions: [
        {
          sku: "X",
          code: "price_variance",
          message: "",
          variancePct: 0.07,
          invoiceValue: 1,
          expectedValue: 1,
        },
      ],
    }),
  );
  assert.match(d.reason, /7\.0%/);
  assert.match(d.reason, /2,000/);
});
