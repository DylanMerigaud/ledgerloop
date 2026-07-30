/**
 * Demo: an error that nets to zero at invoice level.
 *
 * Two lines are wrong in opposite directions by the same amount. The invoice
 * total still ties to the PO total exactly, so any check that compares totals
 * passes. The line-level matcher joins on SKU and catches both.
 *
 * Run from the repo root: pnpm tsx scripts/demo-nets-to-zero.ts
 */
import type { Invoice, PurchaseOrder } from "@/lib/schema";

import { runMatch } from "@/lib/matching";

const purchaseOrder: PurchaseOrder = {
  poNumber: "PO-100",
  vendor: "Acme Steel",
  currency: "USD",
  lineItems: [
    { sku: "BOLT-M8", description: "M8 bolts", qty: 100, unitPrice: 2, amount: 200 },
    { sku: "NUT-M8", description: "M8 nuts", qty: 100, unitPrice: 1, amount: 100 },
  ],
  total: 300,
  department: "",
};

// BOLT-M8 invoiced at 2.50 instead of 2.00 (+50). NUT-M8 at 0.50 instead of
// 1.00 (-50). The two errors cancel, so the invoice total is untouched.
const invoice: Invoice = {
  invoiceNumber: "INV-100",
  poNumber: "PO-100",
  vendor: "Acme Steel",
  issueDate: "2026-05-01",
  currency: "USD",
  lineItems: [
    { sku: "BOLT-M8", description: "M8 bolts", qty: 100, unitPrice: 2.5, amount: 250 },
    { sku: "NUT-M8", description: "M8 nuts", qty: 100, unitPrice: 0.5, amount: 50 },
  ],
  subtotal: 300,
  tax: null,
  total: 300,
};

const usd = (n: number) => `$${n.toFixed(2)}`;

console.log("");
console.log("  TOTALS ONLY");
console.log(`    invoice   ${usd(invoice.total)}`);
console.log(`    PO        ${usd(purchaseOrder.total)}`);
console.log(`    diff      ${usd(invoice.total - purchaseOrder.total)}   PASS`);
console.log("");

const result = runMatch({ invoice, purchaseOrder, goodsReceipt: null });

// Same convention as lib/matching.ts: variancePct holds an unsigned fraction.
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log("  LINE LEVEL, JOINED ON SKU");
for (const e of result.exceptions) {
  console.log(
    `    ${e.sku.padEnd(8)} ${usd(e.invoiceValue ?? 0)} vs ${usd(e.expectedValue ?? 0)}  ${pct(
      e.variancePct
    )}  ${e.code}`
  );
}
console.log(`    verdict   ${result.verdict.toUpperCase()}`);
console.log("");
