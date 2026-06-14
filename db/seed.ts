import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { invoices, purchaseOrders, goodsReceipts, agentRuns } from "./schema";
import { SEED_BUNDLES } from "./seed-data";
import { Invoice, PurchaseOrder, GoodsReceipt } from "@/lib/schema";

/**
 * Seed script — `pnpm db:seed`.
 *
 * Loads the edge-case dataset (see `seed-data.ts`) into the three document
 * tables, validating every bundle through the Zod source of truth first so we
 * never write a malformed row. It deliberately leaves `agent_runs` EMPTY: the
 * public demo never persists runs (it streams the trace and forgets), so there's
 * nothing to seed there — the table exists to document the stateful shape.
 *
 * Idempotent: it truncates the document tables, then re-inserts, so re-running
 * always yields the same pristine dataset. Uses DIRECT_DATABASE_URL if set
 * (Supabase wants a direct, non-pooled connection for DDL/bulk writes), else
 * falls back to DATABASE_URL.
 */

async function main() {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "✖ Set DATABASE_URL (or DIRECT_DATABASE_URL) before seeding — see .env.example.",
    );
    process.exit(1);
  }

  const sql = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(sql);

  try {
    // Validate the whole corpus up front — fail before touching the DB if the
    // seed data ever drifts from the schema.
    for (const b of SEED_BUNDLES) {
      Invoice.parse(b.invoice);
      if (b.purchaseOrder) PurchaseOrder.parse(b.purchaseOrder);
      if (b.goodsReceipt) GoodsReceipt.parse(b.goodsReceipt);
    }

    console.log("→ Clearing existing rows…");
    // agent_runs first (it references nothing, but keep the demo's invariant
    // explicit: it should always be empty after a seed).
    await db.delete(agentRuns);
    await db.delete(goodsReceipts);
    await db.delete(purchaseOrders);
    await db.delete(invoices);

    let invCount = 0;
    let poCount = 0;
    let grCount = 0;
    const seenPo = new Set<string>();
    const seenGr = new Set<string>();

    // Assign explicit, strictly-increasing createdAt timestamps in array order so
    // ordering (and thus duplicate detection — the original must precede its
    // re-send) is deterministic, not at the mercy of defaultNow() collisions in a
    // fast batch insert.
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

    console.log(
      `✓ Seeded ${invCount} invoices, ${poCount} purchase orders, ${grCount} goods receipts.`,
    );
    console.log("✓ agent_runs left empty (the demo never persists runs).");
    console.log(
      "  Edge cases: price mismatch (INV-2042), quantity mismatch (INV-2048), duplicate (INV-2041).",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("✖ Seed failed:", err);
  process.exit(1);
});
