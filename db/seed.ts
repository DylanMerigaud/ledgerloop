import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { resetAndReseed } from "@/db/reset";

/**
 * Seed script — `pnpm db:seed`.
 *
 * Truncates the document tables + `agent_runs`, then re-inserts the seeded
 * dataset (the shared `resetAndReseed` in db/reset.ts does the work, so the CLI
 * and the nightly cron can't drift). Uses DIRECT_DATABASE_URL if set (Supabase
 * wants a direct, non-pooled connection for bulk writes), else DATABASE_URL.
 */
const main = async () => {
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
    console.log("→ Clearing existing rows + reseeding…");
    const counts = await resetAndReseed(db);
    console.log(
      `✓ Seeded ${counts.invoices} invoices, ${counts.purchaseOrders} purchase orders, ${counts.goodsReceipts} goods receipts.`,
    );
    console.log(
      "✓ agent_runs cleared (the nightly reset keeps the demo pristine).",
    );
    console.log(
      "  Edge cases: price mismatch (INV-2042), quantity mismatch (INV-2048), duplicate (INV-2041), already-paid (INV-1990), inactive vendor (INV-2050).",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
};

main().catch((err) => {
  console.error("✖ Seed failed:", err);
  process.exit(1);
});
