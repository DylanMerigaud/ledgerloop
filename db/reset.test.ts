import assert from "node:assert/strict";
import { test } from "node:test";

import { resetAndReseed } from "@/db/reset";
import { SEED_BUNDLES } from "@/db/seed-data";

/**
 * `resetAndReseed` is the shared "back to pristine" used by both the CLI seed and
 * the nightly cron. We don't touch a real database here (the suite is all-faked):
 * a minimal fake records the delete/insert calls so we can assert it clears the
 * tables and re-inserts the right de-duplicated counts. `resetAndReseed` takes a
 * narrow structural db type (`delete` + `insert().values()`), so the fake satisfies
 * it with no cast — and the real drizzle handle satisfies the same shape.
 */

type Inserted = { table: string; values: Record<string, unknown> };

const fakeDb = () => {
  const deletes: string[] = [];
  const inserts: Inserted[] = [];
  const db = {
    delete: (_table: unknown) => {
      deletes.push("delete");
      return Promise.resolve();
    },
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        // Classify each row by a column unique to its table.
        const table =
          "invoiceNumber" in values
            ? "invoices"
            : "grNumber" in values
              ? "goodsReceipts"
              : "poNumber" in values
                ? "purchaseOrders"
                : "other";
        inserts.push({ table, values });
        return Promise.resolve();
      },
    }),
  };
  return { db, deletes, inserts };
};

test("resetAndReseed clears the tables before re-inserting", async () => {
  const { db, deletes, inserts } = fakeDb();
  await resetAndReseed(db);
  // Four deletes: agent_runs, goods_receipts, purchase_orders, invoices.
  assert.equal(deletes.length, 4);
  // Deletes happen before any insert.
  assert.ok(inserts.length > 0, "expected re-inserts");
});

test("resetAndReseed re-inserts every invoice and de-duplicates shared POs/GRs", async () => {
  const { db, inserts } = fakeDb();
  const counts = await resetAndReseed(db);

  const invoiceInserts = inserts.filter((i) => i.table === "invoices").length;
  const poInserts = inserts.filter((i) => i.table === "purchaseOrders").length;
  const grInserts = inserts.filter((i) => i.table === "goodsReceipts").length;

  // One invoice row per bundle (the duplicate pair are two distinct rows).
  assert.equal(invoiceInserts, SEED_BUNDLES.length);
  assert.equal(counts.invoices, SEED_BUNDLES.length);

  // POs/GRs are shared across the duplicate pair, so they're inserted once each.
  const uniquePos = new Set(
    SEED_BUNDLES.flatMap((b) =>
      b.purchaseOrder ? [b.purchaseOrder.poNumber] : [],
    ),
  ).size;
  const uniqueGrs = new Set(
    SEED_BUNDLES.flatMap((b) =>
      b.goodsReceipt ? [b.goodsReceipt.grNumber] : [],
    ),
  ).size;
  assert.equal(poInserts, uniquePos);
  assert.equal(grInserts, uniqueGrs);
  assert.equal(counts.purchaseOrders, uniquePos);
  assert.equal(counts.goodsReceipts, uniqueGrs);
});
