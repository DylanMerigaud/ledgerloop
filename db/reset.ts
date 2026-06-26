import type { PgTable } from "drizzle-orm/pg-core";

import {
  invoices,
  purchaseOrders,
  goodsReceipts,
  agentRuns,
} from "@/db/schema";
import { SEED_BUNDLES } from "@/db/seed-data";
import { Invoice, PurchaseOrder, GoodsReceipt } from "@/lib/schema";

/**
 * Truncate the document tables + `agent_runs`, then re-insert the seeded dataset —
 * the single source of "reset to pristine", shared by the CLI seed (`pnpm db:seed`)
 * and the nightly cron (`app/api/reset`).
 *
 * IMPORTANT scope: this resets ONLY Postgres. It never touches the ERP/HRIS
 * sandboxes — those are frozen fixtures the pipeline reads, never writes. So a
 * reset can't fail on a rotated QBO token, and it can't desync the external
 * systems. The only stateful thing the app writes is `agent_runs` (an append-only
 * audit log), which this clears so the demo returns to a clean queue each day.
 *
 * Idempotent: deletes then re-inserts, so re-running yields the same dataset.
 * Assigns explicit, strictly-increasing `createdAt` stamps in array order so the
 * order-aware duplicate detection (the original must precede its re-send) is
 * deterministic, not at the mercy of `defaultNow()` collisions in a batch insert.
 */
export type ResetCounts = {
  invoices: number;
  purchaseOrders: number;
  goodsReceipts: number;
};

/**
 * The narrow slice of the drizzle handle this function uses — `delete(table)` and
 * `insert(table).values(row)`. Declaring the parameter as this slice (rather than
 * the full `Database`) means the real handle satisfies it structurally AND a test
 * can pass a tiny fake with no cast. We only need the calls to resolve; the return
 * values are ignored.
 */
type SeedWritableDb = {
  delete: (table: PgTable) => unknown;
  insert: (table: PgTable) => {
    values: (row: Record<string, unknown>) => unknown;
  };
};

export const resetAndReseed = async (
  db: SeedWritableDb,
): Promise<ResetCounts> => {
  // Validate the whole corpus up front — fail before touching the DB if the seed
  // data ever drifts from the schema.
  for (const b of SEED_BUNDLES) {
    Invoice.parse(b.invoice);
    if (b.purchaseOrder) PurchaseOrder.parse(b.purchaseOrder);
    if (b.goodsReceipt) GoodsReceipt.parse(b.goodsReceipt);
  }

  // Clear everything the demo writes or seeds. agent_runs first (the audit log we
  // wipe nightly), then the document tables.
  await db.delete(agentRuns);
  await db.delete(goodsReceipts);
  await db.delete(purchaseOrders);
  await db.delete(invoices);

  let invCount = 0;
  let poCount = 0;
  let grCount = 0;
  const seenPo = new Set<string>();
  const seenGr = new Set<string>();

  const base = new Date("2026-05-04T09:00:00Z").getTime();
  let i = 0;
  for (const b of SEED_BUNDLES) {
    const createdAt = new Date(base + i * 60_000); // +1 min per row
    i++;
    await db.insert(invoices).values({
      id: b.id,
      invoiceNumber: b.invoice.invoiceNumber,
      poNumber: b.invoice.poNumber ?? null,
      vendor: b.invoice.vendor,
      issueDate: b.invoice.issueDate,
      currency: b.invoice.currency,
      lineItems: b.invoice.lineItems,
      subtotal: b.invoice.subtotal,
      tax: b.invoice.tax ?? null,
      total: b.invoice.total,
      scenario: b.scenario,
      createdAt,
    });
    invCount++;

    // POs and GRs are shared across the duplicate pair, so insert each once.
    if (b.purchaseOrder && !seenPo.has(b.purchaseOrder.poNumber)) {
      await db.insert(purchaseOrders).values({
        id: b.purchaseOrder.poNumber,
        poNumber: b.purchaseOrder.poNumber,
        vendor: b.purchaseOrder.vendor,
        currency: b.purchaseOrder.currency,
        lineItems: b.purchaseOrder.lineItems,
        total: b.purchaseOrder.total,
        department: b.purchaseOrder.department,
      });
      seenPo.add(b.purchaseOrder.poNumber);
      poCount++;
    }

    if (b.goodsReceipt && !seenGr.has(b.goodsReceipt.grNumber)) {
      await db.insert(goodsReceipts).values({
        id: b.goodsReceipt.grNumber,
        grNumber: b.goodsReceipt.grNumber,
        poNumber: b.goodsReceipt.poNumber,
        receivedDate: b.goodsReceipt.receivedDate,
        lineItems: b.goodsReceipt.lineItems,
      });
      seenGr.add(b.goodsReceipt.grNumber);
      grCount++;
    }
  }

  return {
    invoices: invCount,
    purchaseOrders: poCount,
    goodsReceipts: grCount,
  };
};
