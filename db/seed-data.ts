import type { Invoice, PurchaseOrder, GoodsReceipt } from "@/lib/schema";

/**
 * The seeded dataset — the demo scenario.
 *
 * ~10 invoices with their purchase orders and goods receipts, deliberately
 * including the edge cases the spec calls for, because the agents CATCHING these
 * is what sells the demo:
 *
 *   • price mismatch     — INV-2042 (steel bar invoiced 9% over the PO price)
 *   • quantity mismatch  — INV-2048 (invoiced more units than were received)
 *   • duplicate invoice  — INV-2041 appears twice (same number, second is a re-send)
 *
 * Plus straight-through "clean" matches (the happy path), a 2-way match with no
 * goods receipt (services), an arithmetic error, and an off-PO line — so the
 * dashboard shows a realistic mix of verdicts, not just the three exceptions.
 *
 * The data is shaped so the PURE matcher (`lib/matching.ts`) produces a
 * deterministic verdict for each — no reliance on the LLM to "decide". A seed is
 * defined as a {invoice, po?, gr?, scenario} bundle; `scenario` is a short label
 * the queue shows.
 */

export interface SeedBundle {
  /** A stable, unique row id (the duplicate needs a distinct id from its twin). */
  id: string;
  scenario: string;
  invoice: Invoice;
  purchaseOrder?: PurchaseOrder;
  goodsReceipt?: GoodsReceipt;
}

/* Helper to keep line construction terse + arithmetically correct by default. */
function line(
  sku: string,
  description: string,
  qty: number,
  unitPrice: number,
) {
  return { sku, description, qty, unitPrice, amount: round2(qty * unitPrice) };
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function sum(items: { amount: number }[]): number {
  return round2(items.reduce((a, b) => a + b.amount, 0));
}

/* ── 1. Clean 3-way match (straight-through) ────────────────────────────────
   Industrial fasteners; invoice = PO = receipt. Auto-approved. */
const cleanLines = [
  line("BOLT-M8-50", "Hex bolt M8×50 (box/100)", 40, 12.5),
  line("NUT-M8", "Hex nut M8 (box/100)", 40, 4.2),
  line("WSH-M8", "Flat washer M8 (box/200)", 20, 3.1),
];
const clean: SeedBundle = {
  id: "INV-2040",
  scenario: "Clean 3-way match",
  invoice: {
    invoiceNumber: "INV-2040",
    poNumber: "PO-7740",
    vendor: "Atlas Fasteners",
    issueDate: "2026-05-04",
    currency: "USD",
    lineItems: cleanLines,
    subtotal: sum(cleanLines),
    tax: round2(sum(cleanLines) * 0.0),
    total: sum(cleanLines),
  },
  purchaseOrder: {
    poNumber: "PO-7740",
    vendor: "Atlas Fasteners",
    currency: "USD",
    lineItems: cleanLines,
    total: sum(cleanLines),
  },
  goodsReceipt: {
    grNumber: "GR-5540",
    poNumber: "PO-7740",
    receivedDate: "2026-05-06",
    lineItems: cleanLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};

/* ── 2. DUPLICATE invoice ───────────────────────────────────────────────────
   INV-2041 is sent, then the vendor re-sends the identical invoice. Both rows
   carry invoiceNumber "INV-2041" (distinct primary keys). The matcher blocks
   the duplicate to prevent a double payment. */
const dupLines = [
  line("SVR-RACK-42U", "42U server rack", 2, 1450),
  line("PDU-30A", "30A rack PDU", 4, 320),
];
const dupInvoiceBase: Invoice = {
  invoiceNumber: "INV-2041",
  poNumber: "PO-7741",
  vendor: "NorthBridge Datacenter Supply",
  issueDate: "2026-05-05",
  currency: "USD",
  lineItems: dupLines,
  subtotal: sum(dupLines),
  tax: null,
  total: sum(dupLines),
};
const dupOriginal: SeedBundle = {
  id: "INV-2041",
  scenario: "Original (paid)",
  invoice: dupInvoiceBase,
  purchaseOrder: {
    poNumber: "PO-7741",
    vendor: "NorthBridge Datacenter Supply",
    currency: "USD",
    lineItems: dupLines,
    total: sum(dupLines),
  },
  goodsReceipt: {
    grNumber: "GR-5541",
    poNumber: "PO-7741",
    receivedDate: "2026-05-07",
    lineItems: dupLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};
const dupResend: SeedBundle = {
  id: "INV-2041-RESEND",
  scenario: "Duplicate invoice",
  invoice: { ...dupInvoiceBase }, // same invoiceNumber → flagged as duplicate
  // shares PO-7741 / GR-5541 (loaded by poNumber)
};

/* ── 3. PRICE MISMATCH ──────────────────────────────────────────────────────
   Steel bar invoiced at 9% over the agreed PO unit price. Routed to approval
   (9% < 10% director threshold but a 5k+ line → director on amount). */
const poSteelLines = [
  line("STL-BAR-20", "Cold-rolled steel bar 20mm (per m)", 800, 7.5),
  line("STL-SHEET-2", "Steel sheet 2mm (per m²)", 120, 18),
];
const invSteelLines = [
  { ...line("STL-BAR-20", "Cold-rolled steel bar 20mm (per m)", 800, 8.18) }, // 7.5 → 8.18 ≈ +9.07%
  line("STL-SHEET-2", "Steel sheet 2mm (per m²)", 120, 18),
];
const priceMismatch: SeedBundle = {
  id: "INV-2042",
  scenario: "Price mismatch",
  invoice: {
    invoiceNumber: "INV-2042",
    poNumber: "PO-7742",
    vendor: "Severn Steelworks",
    issueDate: "2026-05-08",
    currency: "GBP",
    lineItems: invSteelLines,
    subtotal: sum(invSteelLines),
    tax: null,
    total: sum(invSteelLines),
  },
  purchaseOrder: {
    poNumber: "PO-7742",
    vendor: "Severn Steelworks",
    currency: "GBP",
    lineItems: poSteelLines,
    total: sum(poSteelLines),
  },
  goodsReceipt: {
    grNumber: "GR-5542",
    poNumber: "PO-7742",
    receivedDate: "2026-05-10",
    lineItems: poSteelLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};

/* ── 4. Clean 2-way match — SERVICES (no goods receipt) ──────────────────────
   A consulting invoice: matched to a PO but there's nothing to "receive", so
   it's a 2-way match. Clean → straight-through. */
const svcLines = [
  line("CONSULT-SR", "Senior consultant (day)", 8, 1200),
  line("CONSULT-PM", "Project manager (day)", 4, 950),
];
const cleanServices: SeedBundle = {
  id: "INV-2043",
  scenario: "Clean 2-way (services)",
  invoice: {
    invoiceNumber: "INV-2043",
    poNumber: "PO-7743",
    vendor: "Lumen Advisory",
    issueDate: "2026-05-09",
    currency: "EUR",
    lineItems: svcLines,
    subtotal: sum(svcLines),
    tax: round2(sum(svcLines) * 0.2),
    total: round2(sum(svcLines) * 1.2),
  },
  purchaseOrder: {
    poNumber: "PO-7743",
    vendor: "Lumen Advisory",
    currency: "EUR",
    lineItems: svcLines,
    total: sum(svcLines),
  },
  // no goodsReceipt → 2-way
};

/* ── 5. Another clean 3-way (volume, makes the queue feel real) ──────────────*/
const pkgLines = [
  line("BOX-A4", "A4 shipping box (bundle/25)", 60, 8.4),
  line("TAPE-48", "Packing tape 48mm (pack/6)", 30, 11.2),
  line("WRAP-500", "Stretch wrap 500mm", 24, 14.5),
];
const cleanPackaging: SeedBundle = {
  id: "INV-2044",
  scenario: "Clean 3-way match",
  invoice: {
    invoiceNumber: "INV-2044",
    poNumber: "PO-7744",
    vendor: "Meridian Packaging",
    issueDate: "2026-05-10",
    currency: "USD",
    lineItems: pkgLines,
    subtotal: sum(pkgLines),
    tax: null,
    total: sum(pkgLines),
  },
  purchaseOrder: {
    poNumber: "PO-7744",
    vendor: "Meridian Packaging",
    currency: "USD",
    lineItems: pkgLines,
    total: sum(pkgLines),
  },
  goodsReceipt: {
    grNumber: "GR-5544",
    poNumber: "PO-7744",
    receivedDate: "2026-05-12",
    lineItems: pkgLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};

/* ── 6. ARITHMETIC ERROR ────────────────────────────────────────────────────
   A line whose amount doesn't equal qty × unitPrice (transcription slip).
   Small variance → manager tier. */
const mathPoLines = [
  line("INK-CYAN", "Cyan ink cartridge", 10, 64),
  line("INK-MAG", "Magenta ink cartridge", 10, 64),
];
const mathInvLines = [
  {
    sku: "INK-CYAN",
    description: "Cyan ink cartridge",
    qty: 10,
    unitPrice: 64,
    amount: 680,
  }, // should be 640
  line("INK-MAG", "Magenta ink cartridge", 10, 64),
];
const arithmetic: SeedBundle = {
  id: "INV-2045",
  scenario: "Arithmetic error",
  invoice: {
    invoiceNumber: "INV-2045",
    poNumber: "PO-7745",
    vendor: "Pinpoint Print Supplies",
    issueDate: "2026-05-11",
    currency: "USD",
    lineItems: mathInvLines,
    subtotal: round2(mathInvLines.reduce((a, b) => a + b.amount, 0)),
    tax: null,
    total: round2(mathInvLines.reduce((a, b) => a + b.amount, 0)),
  },
  purchaseOrder: {
    poNumber: "PO-7745",
    vendor: "Pinpoint Print Supplies",
    currency: "USD",
    lineItems: mathPoLines,
    total: sum(mathPoLines),
  },
  goodsReceipt: {
    grNumber: "GR-5545",
    poNumber: "PO-7745",
    receivedDate: "2026-05-13",
    lineItems: mathPoLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};

/* ── 7. OFF-PO LINE ─────────────────────────────────────────────────────────
   Invoice contains a line that was never on the PO (scope creep / wrong item).
   Routed to approval. */
const offpoPoLines = [line("LAPTOP-14", '14" business laptop', 5, 1280)];
const offpoInvLines = [
  line("LAPTOP-14", '14" business laptop', 5, 1280),
  line("DOCK-USBC", "USB-C docking station", 5, 210),
];
const offPo: SeedBundle = {
  id: "INV-2046",
  scenario: "Line not on PO",
  invoice: {
    invoiceNumber: "INV-2046",
    poNumber: "PO-7746",
    vendor: "Vertex IT Hardware",
    issueDate: "2026-05-12",
    currency: "USD",
    lineItems: offpoInvLines,
    subtotal: sum(offpoInvLines),
    tax: null,
    total: sum(offpoInvLines),
  },
  purchaseOrder: {
    poNumber: "PO-7746",
    vendor: "Vertex IT Hardware",
    currency: "USD",
    lineItems: offpoPoLines,
    total: sum(offpoPoLines),
  },
  goodsReceipt: {
    grNumber: "GR-5546",
    poNumber: "PO-7746",
    receivedDate: "2026-05-14",
    lineItems: offpoInvLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};

/* ── 8. Clean 3-way (chemicals) ─────────────────────────────────────────────*/
const chemLines = [
  line("SOLV-IPA-5L", "Isopropyl alcohol 99% (5L)", 30, 22),
  line("GLOVE-NITR", "Nitrile gloves (box/100)", 50, 9.5),
];
const cleanChem: SeedBundle = {
  id: "INV-2047",
  scenario: "Clean 3-way match",
  invoice: {
    invoiceNumber: "INV-2047",
    poNumber: "PO-7747",
    vendor: "Halcyon Lab Supplies",
    issueDate: "2026-05-13",
    currency: "USD",
    lineItems: chemLines,
    subtotal: sum(chemLines),
    tax: null,
    total: sum(chemLines),
  },
  purchaseOrder: {
    poNumber: "PO-7747",
    vendor: "Halcyon Lab Supplies",
    currency: "USD",
    lineItems: chemLines,
    total: sum(chemLines),
  },
  goodsReceipt: {
    grNumber: "GR-5547",
    poNumber: "PO-7747",
    receivedDate: "2026-05-15",
    lineItems: chemLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};

/* ── 9. QUANTITY MISMATCH (over-received) ───────────────────────────────────
   Invoiced for 100 units of cable but only 80 were received. The PO ordered
   100, so the PO check passes — only the 3-way RECEIPT check catches it. Large
   variance (25%) → director tier. This is the showcase for why 3-way matters. */
const qtyPoLines = [line("CAT6-305", "Cat6 cable 305m reel", 100, 95)];
const qtyInvLines = [line("CAT6-305", "Cat6 cable 305m reel", 100, 95)];
const qtyMismatch: SeedBundle = {
  id: "INV-2048",
  scenario: "Quantity mismatch",
  invoice: {
    invoiceNumber: "INV-2048",
    poNumber: "PO-7748",
    vendor: "Conduit Cable Co",
    issueDate: "2026-05-14",
    currency: "USD",
    lineItems: qtyInvLines,
    subtotal: sum(qtyInvLines),
    tax: null,
    total: sum(qtyInvLines),
  },
  purchaseOrder: {
    poNumber: "PO-7748",
    vendor: "Conduit Cable Co",
    currency: "USD",
    lineItems: qtyPoLines,
    total: sum(qtyPoLines),
  },
  goodsReceipt: {
    grNumber: "GR-5548",
    poNumber: "PO-7748",
    receivedDate: "2026-05-16",
    lineItems: [
      { sku: "CAT6-305", description: "Cat6 cable 305m reel", receivedQty: 80 },
    ], // only 80 of 100
  },
};

/* ── 10. Clean 3-way (office) — rounds the queue to a healthy majority-clean ─*/
const officeLines = [
  line("CHAIR-ERG", "Ergonomic task chair", 12, 240),
  line("DESK-STD", "Sit-stand desk", 12, 410),
];
const cleanOffice: SeedBundle = {
  id: "INV-2049",
  scenario: "Clean 3-way match",
  invoice: {
    invoiceNumber: "INV-2049",
    poNumber: "PO-7749",
    vendor: "Forma Office",
    issueDate: "2026-05-15",
    currency: "EUR",
    lineItems: officeLines,
    subtotal: sum(officeLines),
    tax: round2(sum(officeLines) * 0.2),
    total: round2(sum(officeLines) * 1.2),
  },
  purchaseOrder: {
    poNumber: "PO-7749",
    vendor: "Forma Office",
    currency: "EUR",
    lineItems: officeLines,
    total: sum(officeLines),
  },
  goodsReceipt: {
    grNumber: "GR-5549",
    poNumber: "PO-7749",
    receivedDate: "2026-05-17",
    lineItems: officeLines.map((l) => ({
      sku: l.sku,
      description: l.description,
      receivedQty: l.qty,
    })),
  },
};

/** The full seed set, in the order they appear in the queue. */
export const SEED_BUNDLES: SeedBundle[] = [
  clean,
  dupOriginal,
  dupResend,
  priceMismatch,
  cleanServices,
  cleanPackaging,
  arithmetic,
  offPo,
  cleanChem,
  qtyMismatch,
  cleanOffice,
];
