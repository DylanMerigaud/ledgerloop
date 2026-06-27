import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApprovalWorkflow,
  type ApprovalStep,
  type Condition,
  approversOf,
  evaluateCondition,
  describeCondition,
  humanizeCondition,
  type InvoiceContext,
} from "@/lib/approval-workflow";

/**
 * The condition evaluator is the load-bearing part of the DAG model — the engine
 * (B-3) routes on it, so it must be exact. Plus a check that a realistic derived
 * workflow validates against the schema (the shape the agent will emit).
 */

const ctx = (over: Partial<InvoiceContext> = {}): InvoiceContext => ({
  amount: 1000,
  exceptionAmount: 0,
  variancePct: 0,
  department: "Finance",
  verdict: "clean",
  vendor: "Acme",
  currency: "USD",
  matchType: "three_way",
  exceptionCodes: [],
  ...over,
});

test("always is unconditionally true", () => {
  assert.equal(evaluateCondition({ kind: "always" }, ctx()), true);
});

test("numeric leaf: amount > 5000", () => {
  const cond: Condition = {
    kind: "leaf",
    field: "amount",
    op: ">",
    value: 5000,
  };
  assert.equal(evaluateCondition(cond, ctx({ amount: 6000 })), true);
  assert.equal(evaluateCondition(cond, ctx({ amount: 5000 })), false); // strict >
  assert.equal(evaluateCondition(cond, ctx({ amount: 100 })), false);
});

test("string leaf: department == IT (equality only)", () => {
  const cond: Condition = {
    kind: "leaf",
    field: "department",
    op: "==",
    value: "IT",
  };
  assert.equal(evaluateCondition(cond, ctx({ department: "IT" })), true);
  assert.equal(evaluateCondition(cond, ctx({ department: "Finance" })), false);
});

test("vendor / currency / matchType leaves match on equality", () => {
  const vendor: Condition = {
    kind: "leaf",
    field: "vendor",
    op: "==",
    value: "Severn Steelworks",
  };
  assert.equal(
    evaluateCondition(vendor, ctx({ vendor: "Severn Steelworks" })),
    true,
  );
  assert.equal(evaluateCondition(vendor, ctx({ vendor: "Atlas" })), false);

  const cur: Condition = {
    kind: "leaf",
    field: "currency",
    op: "==",
    value: "EUR",
  };
  assert.equal(evaluateCondition(cur, ctx({ currency: "EUR" })), true);
  assert.equal(evaluateCondition(cur, ctx({ currency: "USD" })), false);

  const mt: Condition = {
    kind: "leaf",
    field: "matchType",
    op: "==",
    value: "two_way",
  };
  assert.equal(evaluateCondition(mt, ctx({ matchType: "two_way" })), true);
  assert.equal(evaluateCondition(mt, ctx({ matchType: "three_way" })), false);
});

test("exceptionCode is set membership: == has the flag, != lacks it", () => {
  const has: Condition = {
    kind: "leaf",
    field: "exceptionCode",
    op: "==",
    value: "vendor_inactive",
  };
  assert.equal(
    evaluateCondition(has, ctx({ exceptionCodes: ["vendor_inactive"] })),
    true,
  );
  assert.equal(
    evaluateCondition(has, ctx({ exceptionCodes: ["price_variance"] })),
    false,
  );
  assert.equal(evaluateCondition(has, ctx({ exceptionCodes: [] })), false);

  const lacks: Condition = {
    kind: "leaf",
    field: "exceptionCode",
    op: "!=",
    value: "vendor_inactive",
  };
  assert.equal(evaluateCondition(lacks, ctx({ exceptionCodes: [] })), true);
  assert.equal(
    evaluateCondition(lacks, ctx({ exceptionCodes: ["vendor_inactive"] })),
    false,
  );
});

test("humanizeCondition reads the new levers plainly", () => {
  const h = (c: Condition) => humanizeCondition(c);
  assert.equal(
    h({ kind: "leaf", field: "vendor", op: "==", value: "Severn Steelworks" }),
    "Vendor: Severn Steelworks",
  );
  assert.equal(
    h({ kind: "leaf", field: "currency", op: "==", value: "EUR" }),
    "EUR only",
  );
  assert.equal(
    h({ kind: "leaf", field: "matchType", op: "==", value: "two_way" }),
    "2-way match",
  );
  assert.equal(
    h({
      kind: "leaf",
      field: "exceptionCode",
      op: "==",
      value: "vendor_inactive",
    }),
    "Has vendor inactive flag",
  );
});

test("ordering ops on a string are false, not a surprise sort", () => {
  const cond: Condition = {
    kind: "leaf",
    field: "department",
    op: ">",
    value: "IT",
  };
  assert.equal(
    evaluateCondition(cond, ctx({ department: "Marketing" })),
    false,
  );
});

test("all requires every sub-condition; any requires one", () => {
  const big = { kind: "leaf", field: "amount", op: ">", value: 5000 } as const;
  const it = {
    kind: "leaf",
    field: "department",
    op: "==",
    value: "IT",
  } as const;

  const all: Condition = { kind: "all", conditions: [big, it] };
  assert.equal(
    evaluateCondition(all, ctx({ amount: 9000, department: "IT" })),
    true,
  );
  assert.equal(
    evaluateCondition(all, ctx({ amount: 9000, department: "Finance" })),
    false,
  );

  const any: Condition = { kind: "any", conditions: [big, it] };
  assert.equal(
    evaluateCondition(any, ctx({ amount: 100, department: "IT" })),
    true,
  );
  assert.equal(
    evaluateCondition(any, ctx({ amount: 100, department: "Finance" })),
    false,
  );
});

test("nested combinators evaluate correctly", () => {
  // exception AND (amount > 10000 OR variancePct >= 0.1)
  const cond: Condition = {
    kind: "all",
    conditions: [
      { kind: "leaf", field: "verdict", op: "==", value: "exception" },
      {
        kind: "any",
        conditions: [
          { kind: "leaf", field: "amount", op: ">", value: 10000 },
          { kind: "leaf", field: "variancePct", op: ">=", value: 0.1 },
        ],
      },
    ],
  };
  assert.equal(
    evaluateCondition(cond, ctx({ verdict: "exception", variancePct: 0.12 })),
    true,
  );
  assert.equal(
    evaluateCondition(cond, ctx({ verdict: "exception", amount: 500 })),
    false,
  );
  assert.equal(
    evaluateCondition(cond, ctx({ verdict: "clean", amount: 99999 })),
    false,
  );
});

test("describeCondition renders a readable string", () => {
  assert.equal(
    describeCondition({ kind: "leaf", field: "amount", op: ">", value: 5000 }),
    "amount > $5,000",
  );
  assert.equal(
    describeCondition({
      kind: "all",
      conditions: [
        { kind: "leaf", field: "amount", op: ">", value: 5000 },
        { kind: "leaf", field: "department", op: "==", value: "IT" },
      ],
    }),
    "amount > $5,000 and department == IT",
  );
});

test("a realistic derived workflow validates against the schema", () => {
  // The shape the onboarding agent emits for a "PO > $5000 → director, IT → IT review" org.
  const wf = {
    name: "Acme approval workflow",
    roots: ["manager"],
    steps: [
      {
        id: "manager",
        kind: "approval",
        label: "Manager review",
        when: { kind: "always" },
        approverTitle: "Manager",
        approverName: "Esther Howard",
        next: ["director", "it-review", "post"],
      },
      {
        id: "director",
        kind: "approval",
        label: "Director review",
        when: { kind: "leaf", field: "amount", op: ">", value: 5000 },
        approverTitle: "Director",
        approverName: "Jordan Ellis",
        next: ["post"],
      },
      {
        id: "it-review",
        kind: "approval",
        label: "IT review",
        when: { kind: "leaf", field: "department", op: "==", value: "IT" },
        approverTitle: "VP of IT",
        approverName: null, // agent couldn't resolve — human to fill
        next: ["post"],
      },
      {
        id: "post",
        kind: "integration",
        label: "Post to NetSuite",
        when: { kind: "always" },
        integration: "netsuite",
        next: [],
      },
    ],
  };
  assert.doesNotThrow(() => ApprovalWorkflow.parse(wf));
});

test("an unknown step kind is rejected by the schema", () => {
  const bad = {
    name: "x",
    roots: ["a"],
    steps: [
      {
        id: "a",
        kind: "teleport",
        label: "?",
        when: { kind: "always" },
        next: [],
      },
    ],
  };
  assert.throws(() => ApprovalWorkflow.parse(bad));
});

/** A minimal approval step for the roster helper. */
const gate = (over: Partial<ApprovalStep> = {}): ApprovalStep => ({
  id: "g",
  kind: "approval",
  label: "Gate",
  when: { kind: "always" },
  approverTitle: "Director",
  approverName: "Jordan Ellis",
  next: [],
  ...over,
});

test("approversOf: primary then the extras, in order", () => {
  assert.deepEqual(
    approversOf(gate({ approvers: ["Cameron Diaz", "Sam Patel"] })),
    ["Jordan Ellis", "Cameron Diaz", "Sam Patel"],
  );
});

test("approversOf: just the primary when there are no extras", () => {
  assert.deepEqual(approversOf(gate()), ["Jordan Ellis"]);
});

test("approversOf: drops an unresolved primary but keeps the extras", () => {
  assert.deepEqual(
    approversOf(gate({ approverName: null, approvers: ["Cameron Diaz"] })),
    ["Cameron Diaz"],
  );
});

test("approversOf: empty when unresolved with no extras", () => {
  assert.deepEqual(approversOf(gate({ approverName: null })), []);
});
