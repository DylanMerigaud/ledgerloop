import assert from "node:assert/strict";
import { test } from "node:test";

import { runMatch, type MatchInput } from "@/lib/matching";
import type { Invoice, PurchaseOrder, GoodsReceipt } from "@/lib/schema";

/**
 * Unit tests for the 2/3-way matcher — the deterministic core the matching step
 * calls and the demo's edge cases depend on. Run with `pnpm test` (Node's
 * built-in runner via tsx, no extra deps). These pin the exact verdicts that
 * drive the workflow's conditional routing.
 */
const invoice = (over: Partial<Invoice> = {}): Invoice => {
  return {
    invoiceNumber: "INV-100",
    poNumber: "PO-100",
    vendor: "Acme Steel",
    issueDate: "2026-05-01",
    currency: "USD",
    lineItems: [
      {
        sku: "BOLT-M8",
        description: "M8 bolts",
        qty: 100,
        unitPrice: 2,
        amount: 200,
      },
      {
        sku: "NUT-M8",
        description: "M8 nuts",
        qty: 100,
        unitPrice: 1,
        amount: 100,
      },
    ],
    subtotal: 300,
    tax: null,
    total: 300,
    ...over,
  };
};

const po = (over: Partial<PurchaseOrder> = {}): PurchaseOrder => {
  return {
    poNumber: "PO-100",
    vendor: "Acme Steel",
    currency: "USD",
    lineItems: [
      {
        sku: "BOLT-M8",
        description: "M8 bolts",
        qty: 100,
        unitPrice: 2,
        amount: 200,
      },
      {
        sku: "NUT-M8",
        description: "M8 nuts",
        qty: 100,
        unitPrice: 1,
        amount: 100,
      },
    ],
    total: 300,
    ...over,
  };
};

const receipt = (over: Partial<GoodsReceipt> = {}): GoodsReceipt => {
  return {
    grNumber: "GR-100",
    poNumber: "PO-100",
    receivedDate: "2026-05-03",
    lineItems: [
      { sku: "BOLT-M8", description: "M8 bolts", receivedQty: 100 },
      { sku: "NUT-M8", description: "M8 nuts", receivedQty: 100 },
    ],
    ...over,
  };
};

const run = (over: Partial<MatchInput> = {}) => {
  return runMatch({
    invoice: invoice(),
    purchaseOrder: po(),
    goodsReceipt: receipt(),
    ...over,
  });
};

test("clean 3-way match → clean verdict, no exceptions", () => {
  const r = run();
  assert.equal(r.verdict, "clean");
  assert.equal(r.matchType, "three_way");
  assert.deepEqual(r.exceptions, []);
  assert.equal(r.maxVariancePct, 0);
});

test("no goods receipt → two_way match (still clean)", () => {
  const r = run({ goodsReceipt: null });
  assert.equal(r.matchType, "two_way");
  assert.equal(r.verdict, "clean");
});

test("duplicate invoice number → duplicate verdict, short-circuits", () => {
  const r = run({ priorInvoiceNumbers: ["INV-100"] });
  assert.equal(r.verdict, "duplicate");
  assert.equal(r.exceptionAmount, 300); // full invoice held
});

test("price above PO beyond tolerance → price_variance exception", () => {
  const inv = invoice();
  inv.lineItems[0]!.unitPrice = 2.2; // 10% over PO's 2.00
  inv.lineItems[0]!.amount = 220;
  inv.subtotal = 320;
  inv.total = 320;
  const r = run({ invoice: inv });
  assert.equal(r.verdict, "exception");
  const codes = r.exceptions.map((e) => e.code);
  assert.ok(codes.includes("price_variance"));
  assert.ok(Math.abs(r.maxVariancePct - 0.1) < 1e-9);
});

test("price within 1% tolerance → no exception", () => {
  const inv = invoice();
  inv.lineItems[0]!.unitPrice = 2.01; // 0.5% over
  inv.lineItems[0]!.amount = 201;
  inv.subtotal = 301;
  inv.total = 301;
  const r = run({ invoice: inv });
  assert.equal(r.verdict, "clean");
});

test("quantity above PO → qty_variance_po exception", () => {
  const inv = invoice();
  inv.lineItems[1]!.qty = 150; // PO ordered 100
  inv.lineItems[1]!.amount = 150;
  inv.subtotal = 350;
  inv.total = 350;
  // receipt also has to allow it or we'd double-flag; bump receipt so only PO qty fires
  const gr = receipt();
  gr.lineItems[1]!.receivedQty = 150;
  const r = run({ invoice: inv, goodsReceipt: gr });
  const codes = r.exceptions.map((e) => e.code);
  assert.ok(codes.includes("qty_variance_po"));
  assert.equal(r.verdict, "exception");
});

test("invoiced more than received → qty_variance_receipt (3-way only)", () => {
  const inv = invoice();
  inv.lineItems[0]!.qty = 120;
  inv.lineItems[0]!.amount = 240;
  inv.subtotal = 340;
  inv.total = 340;
  // make the PO agree so ONLY the receipt check fires
  const purchase = po();
  purchase.lineItems[0]!.qty = 120;
  purchase.lineItems[0]!.amount = 240;
  purchase.total = 340;
  const r = run({ invoice: inv, purchaseOrder: purchase }); // receipt still 100
  const codes = r.exceptions.map((e) => e.code);
  assert.ok(codes.includes("qty_variance_receipt"));
});

test("line amount ≠ qty × unitPrice → unit_price_x_qty exception", () => {
  const inv = invoice();
  inv.lineItems[0]!.amount = 250; // 100 × 2 = 200, not 250
  inv.subtotal = 350;
  inv.total = 350;
  const r = run({ invoice: inv });
  const codes = r.exceptions.map((e) => e.code);
  assert.ok(codes.includes("unit_price_x_qty"));
});

test("invoice line absent from PO → no_po_line exception", () => {
  const inv = invoice();
  inv.lineItems.push({
    sku: "WASHER-M8",
    description: "washers",
    qty: 50,
    unitPrice: 1,
    amount: 50,
  });
  inv.subtotal = 350;
  inv.total = 350;
  const gr = receipt();
  gr.lineItems.push({
    sku: "WASHER-M8",
    description: "washers",
    receivedQty: 50,
  });
  const r = run({ invoice: inv, goodsReceipt: gr });
  const codes = r.exceptions.map((e) => e.code);
  assert.ok(codes.includes("no_po_line"));
});

test("exceptionAmount accumulates money on exception lines only", () => {
  const inv = invoice();
  inv.lineItems[0]!.unitPrice = 3; // price variance on a 100-unit line
  inv.lineItems[0]!.amount = 300;
  inv.subtotal = 400;
  inv.total = 400;
  const r = run({ invoice: inv });
  assert.equal(r.exceptionAmount, 300); // the exception line's amount
});
