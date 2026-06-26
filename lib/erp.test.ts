import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  reconcileFromOutcome,
  mapQboPurchaseOrders,
  mapQboVendors,
  mapQboItems,
  mapQboPostedBills,
  recordedErp,
} from "@/lib/erp";
import { PurchaseOrder, type MatchResult } from "@/lib/schema";

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

/* ── PULL side: the QuickBooks PO mapper ──────────────────────────────────────
   Two layers, the same discipline as hris.test.ts:
     1. Mapper logic on small, real-shaped QBO query payloads — pins each cleanup
        rule (item-line filter, DocNumber→poNumber, currency fallback, recompute).
     2. A loose smoke test against the REAL captured fixture — proves the live
        payload maps to valid PurchaseOrders without crashing. */

// A minimal QBO query response — only the fields the mapper reads.
const qboResponse = (pos: unknown[]) => ({
  QueryResponse: { PurchaseOrder: pos },
});

// One item-based line in QBO's real shape. `itemName` is what the matcher keys
// `sku` on (the seed sets the QBO item Name to the SKU); `description` is the
// longer per-line text QBO carries separately.
const itemLine = (
  itemId: string,
  itemName: string,
  qty: number,
  unitPrice: number,
  opts: { amount?: number; description?: string } = {},
) => ({
  DetailType: "ItemBasedExpenseLineDetail",
  Amount: opts.amount ?? qty * unitPrice,
  Description: opts.description ?? itemName,
  ItemBasedExpenseLineDetail: {
    ItemRef: { value: itemId, name: itemName },
    Qty: qty,
    UnitPrice: unitPrice,
  },
});

test("maps a real-shaped QBO PO into a valid internal PurchaseOrder", () => {
  const pos = mapQboPurchaseOrders(
    qboResponse([
      {
        Id: "45",
        DocNumber: "PO-7742",
        VendorRef: { value: "51", name: "Severn Steelworks" },
        CurrencyRef: { value: "USD", name: "United States Dollar" },
        TotalAmt: 6000,
        Line: [
          itemLine("5", "STL-BAR-20", 800, 7.5, {
            description: "Cold-rolled steel bar 20mm (per m)",
          }),
        ],
      },
    ]),
  );
  assert.equal(pos.length, 1);
  const po = pos[0]!;
  // poNumber is the human DocNumber; sku is the item NAME (the matcher key); the
  // longer per-line text becomes the description.
  assert.equal(po.poNumber, "PO-7742");
  assert.equal(po.vendor, "Severn Steelworks");
  assert.equal(po.currency, "USD");
  assert.equal(po.lineItems[0]?.sku, "STL-BAR-20");
  assert.equal(
    po.lineItems[0]?.description,
    "Cold-rolled steel bar 20mm (per m)",
  );
  assert.equal(po.lineItems[0]?.unitPrice, 7.5);
  assert.equal(po.total, 6000);
  // The real assertion: it satisfies the single-source-of-truth schema.
  assert.doesNotThrow(() => PurchaseOrder.parse(po));
});

test("falls back to the internal Id when a PO has no DocNumber", () => {
  const pos = mapQboPurchaseOrders(
    qboResponse([
      {
        Id: "99",
        VendorRef: { value: "1", name: "Acme" },
        Line: [itemLine("5", "Widget", 2, 10)],
      },
    ]),
  );
  assert.equal(pos[0]?.poNumber, "99");
});

test("defaults currency to USD when QBO omits CurrencyRef", () => {
  const pos = mapQboPurchaseOrders(
    qboResponse([
      {
        DocNumber: "1",
        VendorRef: { value: "1", name: "Acme" },
        Line: [itemLine("5", "Widget", 2, 10)],
      },
    ]),
  );
  assert.equal(pos[0]?.currency, "USD");
});

test("recomputes total/line amount when QBO omits them", () => {
  const pos = mapQboPurchaseOrders(
    qboResponse([
      {
        DocNumber: "1",
        VendorRef: { value: "1", name: "Acme" },
        Line: [
          {
            DetailType: "ItemBasedExpenseLineDetail",
            // no Amount on the line
            ItemBasedExpenseLineDetail: {
              ItemRef: { value: "5", name: "Widget" },
              Qty: 3,
              UnitPrice: 7,
            },
          },
        ],
        // no TotalAmt
      },
    ]),
  );
  assert.equal(pos[0]?.lineItems[0]?.amount, 21);
  assert.equal(pos[0]?.total, 21);
});

test("drops non-item lines (subtotals, account-based) the matcher can't join", () => {
  const pos = mapQboPurchaseOrders(
    qboResponse([
      {
        DocNumber: "1",
        VendorRef: { value: "1", name: "Acme" },
        Line: [
          itemLine("5", "Widget", 1, 10),
          // An account-based line with no ItemRef — not matchable.
          { DetailType: "AccountBasedExpenseLineDetail", Amount: 50 },
        ],
      },
    ]),
  );
  assert.equal(pos[0]?.lineItems.length, 1);
  assert.equal(pos[0]?.lineItems[0]?.sku, "Widget");
});

test("skips a PO with a vendor but no matchable line", () => {
  const pos = mapQboPurchaseOrders(
    qboResponse([
      {
        DocNumber: "1",
        VendorRef: { value: "1", name: "Acme" },
        Line: [{ DetailType: "AccountBasedExpenseLineDetail", Amount: 50 }],
      },
    ]),
  );
  assert.equal(pos.length, 0);
});

test("tolerates an empty / shapeless payload without throwing", () => {
  assert.equal(mapQboPurchaseOrders({}).length, 0);
  assert.equal(mapQboPurchaseOrders(null).length, 0);
  assert.equal(mapQboPurchaseOrders({ QueryResponse: {} }).length, 0);
});

/* ── Master-data mappers (Vendor / Item / Bill) ───────────────────────────── */

test("maps QBO vendors, defaulting Active and stripping the '(deleted)' suffix", () => {
  const vendors = mapQboVendors({
    QueryResponse: {
      Vendor: [
        { DisplayName: "Atlas Fasteners" }, // no Active → active
        { DisplayName: "Dormant Metals LLC (deleted)", Active: false },
        { DisplayName: "  " }, // blank → dropped
      ],
    },
  });
  assert.equal(vendors.length, 2);
  const dormant = vendors.find((v) => v.name === "Dormant Metals LLC");
  assert.ok(dormant, "the '(deleted)' suffix is stripped so the name matches");
  assert.equal(dormant.active, false);
  assert.equal(vendors.find((v) => v.name === "Atlas Fasteners")?.active, true);
});

test("maps QBO items, keying the catalog on the item name (the SKU)", () => {
  const items = mapQboItems({
    QueryResponse: {
      Item: [{ Name: "BOLT-M8-50" }, { Name: "STL-BAR-20", Active: true }, {}],
    },
  });
  assert.deepEqual(items.map((i) => i.sku).sort(), [
    "BOLT-M8-50",
    "STL-BAR-20",
  ]);
});

test("maps QBO bills to (vendor, docNumber); drops rows missing either", () => {
  const bills = mapQboPostedBills({
    QueryResponse: {
      Bill: [
        {
          DocNumber: "INV-1990",
          VendorRef: { value: "1", name: "Atlas Fasteners" },
        },
        { DocNumber: "NO-VENDOR" }, // no VendorRef → dropped
        { VendorRef: { value: "2", name: "X" } }, // no DocNumber → dropped
      ],
    },
  });
  assert.equal(bills.length, 1);
  assert.deepEqual(bills[0], {
    vendor: "Atlas Fasteners",
    docNumber: "INV-1990",
  });
});

test("master-data mappers tolerate empty / shapeless payloads", () => {
  assert.equal(mapQboVendors(null).length, 0);
  assert.equal(mapQboItems({}).length, 0);
  assert.equal(mapQboPostedBills({ QueryResponse: {} }).length, 0);
});

test("the recorded QBO fixture maps to valid purchase orders + master data", async (t) => {
  if (!existsSync("db/fixtures/quickbooks/erp.json")) {
    t.skip("fixture missing — run pnpm erp:capture");
    return;
  }
  const erp = recordedErp();
  const pos = await erp.pullPurchaseOrders();
  assert.ok(pos.length > 0, "expected the captured fixture to yield POs");
  for (const p of pos) assert.doesNotThrow(() => PurchaseOrder.parse(p));

  // The seeded control artifacts are present in the real capture.
  const vendors = await erp.pullVendors();
  assert.ok(
    vendors.some((v) => v.name === "Dormant Metals LLC" && !v.active),
    "expected the seeded inactive vendor",
  );
  const bills = await erp.pullPostedBills();
  assert.ok(
    bills.some((b) => b.docNumber === "INV-1990"),
    "expected the seeded posted bill",
  );
});
