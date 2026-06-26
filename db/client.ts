import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { invoices, purchaseOrders, goodsReceipts } from "@/db/schema";
import { env } from "@/lib/env";
import {
  Invoice,
  PurchaseOrder,
  GoodsReceipt,
  type Invoice as TInvoice,
  type PurchaseOrder as TPurchaseOrder,
  type GoodsReceipt as TGoodsReceipt,
} from "@/lib/schema";

/**
 * Read-only database access layer.
 *
 * This app NEVER writes (see the README + the run route on why the demo is
 * stateless). Every function here is a read, and each one validates the row back
 * through the Zod schema at the boundary — the same single-source-of-truth
 * discipline applied to the database edge, so a drifted/garbage row surfaces as
 * a handled error instead of flowing untyped into the pipeline or the UI.
 *
 * The connection is created lazily and memoized so a missing DATABASE_URL fails
 * with a clear message at first use rather than at import time (which would break
 * the build / Edge bundling).
 */

let cached: ReturnType<typeof drizzle> | null = null;

const db = () => {
  if (!cached) {
    // `prepare: false` is the Supabase transaction-pooler-safe setting; one
    // connection is plenty for this read-only demo. `env.DATABASE_URL` is required
    // and validated at env load, so a missing value fails clearly there (the error
    // names DATABASE_URL, which the run route keys its setup notice off).
    const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 });
    cached = drizzle(sql);
  }
  return cached;
};

/** A queue row for the dashboard's left pane — light, list-shaped. */
export type QueueItem = {
  /** Stable per-row key — the value to pass to the run route (NOT the invoice number). */
  id: string;
  invoiceNumber: string;
  vendor: string;
  poNumber: string | null;
  total: number;
  currency: string;
  issueDate: string;
  scenario: string | null;
};

/** All invoices, oldest first, as lightweight queue items for the left pane. */
export const listInvoiceQueue = async (): Promise<QueueItem[]> => {
  const rows = await db()
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      vendor: invoices.vendor,
      poNumber: invoices.poNumber,
      total: invoices.total,
      currency: invoices.currency,
      issueDate: invoices.issueDate,
      scenario: invoices.scenario,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .orderBy(invoices.createdAt, invoices.id);
  return rows.map(({ createdAt: _createdAt, ...item }) => item);
};

/** The full document bundle the pipeline needs for one invoice run. */
export type RunBundle = {
  invoice: TInvoice;
  purchaseOrder: TPurchaseOrder | null;
  goodsReceipt: TGoodsReceipt | null;
  /** Other invoice numbers in the ledger — for duplicate detection. */
  priorInvoiceNumbers: string[];
};

/**
 * Load everything needed to run the pipeline for one invoice, validating each
 * document through Zod on the way out of the database. Returns `null` if the row
 * doesn't exist.
 *
 * Keyed on the row `id` (the queue's stable per-row key), NOT the invoice number,
 * because the duplicate pair deliberately shares an invoice number across two
 * rows ("INV-2041" original + "INV-2041-RESEND"). The id is what lets us load
 * the exact row the visitor clicked and decide whether THAT row is the duplicate.
 */
export const loadRunBundle = async (id: string): Promise<RunBundle | null> => {
  const d = db();

  const [invoiceRow] = await d
    .select()
    .from(invoices)
    .where(eq(invoices.id, id))
    .limit(1);
  if (!invoiceRow) return null;

  const invoice = Invoice.parse(toInvoiceShape(invoiceRow));

  // Purchase order (by the invoice's poNumber, if any).
  let purchaseOrder: TPurchaseOrder | null = null;
  if (invoice.poNumber) {
    const [poRow] = await d
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.poNumber, invoice.poNumber))
      .limit(1);
    if (poRow) purchaseOrder = PurchaseOrder.parse(toPoShape(poRow));
  }

  // Goods receipt (by the PO number, if a PO exists).
  let goodsReceipt: TGoodsReceipt | null = null;
  if (invoice.poNumber) {
    const [grRow] = await d
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.poNumber, invoice.poNumber))
      .limit(1);
    if (grRow) goodsReceipt = GoodsReceipt.parse(toGrShape(grRow));
  }

  // Duplicate detection is ORDER-AWARE: an invoice is a duplicate only if another
  // row for the same vendor already carried this invoice number EARLIER. So the
  // original (first-seen) is clean and a later re-send of the same number is the
  // duplicate — which is how a real AP ledger behaves. We order by createdAt then
  // id (a stable tiebreak when timestamps collide in a batch insert).
  const ledger = await d
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .where(eq(invoices.vendor, invoice.vendor))
    .orderBy(invoices.createdAt, invoices.id);

  // "Earlier" = strictly smaller (createdAt, id) tuple. Compare createdAt
  // NUMERICALLY (not as a string — epoch-millis strings of different lengths
  // would sort wrong lexically), with the row id as a stable tiebreak.
  const thisTime = invoiceRow.createdAt.getTime();
  const thisId = invoiceRow.id;
  const isEarlier = (rTime: number, rId: string) =>
    rTime < thisTime || (rTime === thisTime && rId < thisId);
  const priorInvoiceNumbers = ledger
    .filter((r) => isEarlier(r.createdAt.getTime(), r.id))
    .map((r) => r.invoiceNumber);

  return { invoice, purchaseOrder, goodsReceipt, priorInvoiceNumbers };
};

/**
 * Load just one invoice by row id — a single, light query. Used by the PDF route,
 * which only needs the invoice to render the document (no PO / receipt / ledger,
 * so it skips the three extra reads `loadRunBundle` does). Returns `null` if the
 * row doesn't exist.
 */
export const loadInvoiceById = async (id: string): Promise<TInvoice | null> => {
  const [row] = await db()
    .select()
    .from(invoices)
    .where(eq(invoices.id, id))
    .limit(1);
  if (!row) return null;
  return Invoice.parse(toInvoiceShape(row));
};

/* Row → Zod-input shape mappers. `numeric({ mode: "number" })` already gives us
   numbers; these just drop DB-only columns (id, createdAt, scenario) the Zod
   document schemas don't include (they're `.strict()`). */

const toInvoiceShape = (r: typeof invoices.$inferSelect) => {
  return {
    invoiceNumber: r.invoiceNumber,
    poNumber: r.poNumber,
    vendor: r.vendor,
    issueDate: r.issueDate,
    currency: r.currency,
    lineItems: r.lineItems,
    subtotal: r.subtotal,
    tax: r.tax,
    total: r.total,
  };
};

const toPoShape = (r: typeof purchaseOrders.$inferSelect) => {
  return {
    poNumber: r.poNumber,
    vendor: r.vendor,
    currency: r.currency,
    lineItems: r.lineItems,
    total: r.total,
    department: r.department,
  };
};

const toGrShape = (r: typeof goodsReceipts.$inferSelect) => {
  return {
    grNumber: r.grNumber,
    poNumber: r.poNumber,
    receivedDate: r.receivedDate,
    lineItems: r.lineItems,
  };
};
