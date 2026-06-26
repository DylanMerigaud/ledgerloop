/**
 * Capture the REAL QuickBooks Online master data to a committed fixture.
 *
 * The procurement mirror of capture-bamboo.ts. It calls the live QBO API via the
 * SAME fetchers the production adapter uses (OAuth2 refresh-token → access token →
 * query), for each entity the matcher checks against: purchase orders, the vendor
 * master, the item catalog, and the already-posted bills. It writes each raw
 * response under its own key (plus a dated `_meta` block) to
 * `db/fixtures/quickbooks/erp.json`. `recordedErp()` replays those exact payloads
 * through the same mappers — so the fixture is not a mock, it's QuickBooks' own
 * output, frozen on the date below.
 *
 * Why this exists: the QBO sandbox token/app is short-lived. Capturing the fixture
 * while it's alive means the demo (and CI, which has no key) keeps running on real
 * data afterwards, with the `_meta` stating plainly that it's a recorded snapshot.
 *
 * Run:  pnpm erp:capture   (reads creds from .env.local / .env)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  fetchQboPurchaseOrders,
  fetchQboVendors,
  fetchQboItems,
  fetchQboBills,
  mapQboPurchaseOrders,
  type QboCreds,
} from "@/lib/erp";
import { persistRotatedRefreshToken } from "@/scripts/qbo-token-writeback";

/** Same env loading as eval/run.ts — native, no dotenv dep. */
const loadEnv = (): void => {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.join(process.cwd(), f));
    } catch {
      /* file absent — fine */
    }
  }
};

const main = async (): Promise<void> => {
  loadEnv();
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const refreshToken = process.env.QBO_REFRESH_TOKEN;
  const realmId = process.env.QBO_REALM_ID;
  if (!clientId || !clientSecret || !refreshToken || !realmId) {
    console.error(
      "Missing QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REFRESH_TOKEN / QBO_REALM_ID.\n" +
        "Set them in .env.local — this script needs the live sandbox app to capture.",
    );
    process.exit(1);
  }
  const creds: QboCreds = {
    clientId,
    clientSecret,
    refreshToken,
    realmId,
    accessToken: process.env.QBO_ACCESS_TOKEN,
  };

  console.log(`Fetching ERP data from QBO realm ${realmId} …`);
  const [purchaseOrders, vendors, items, bills] = await Promise.all([
    fetchQboPurchaseOrders(creds),
    fetchQboVendors(creds),
    fetchQboItems(creds),
    fetchQboBills(creds),
  ]);

  // Validate the PO capture is usable BEFORE writing — a fixture whose POs can't
  // be mapped is worse than no fixture (the others can legitimately be empty).
  const pos = mapQboPurchaseOrders(purchaseOrders);
  if (pos.length === 0) {
    console.error(
      "Mapped 0 purchase orders. The sandbox has no item-based POs to read — " +
        "run `pnpm erp:seed` first to create the scenario, then retry.",
    );
    process.exit(1);
  }
  console.log(`Mapped OK: ${pos.length} purchase order(s).`);

  // Provenance: real data, record exactly when/where from. The realm id is written
  // (it's a company id, not a secret); tokens are NOT.
  const payload = {
    _meta: {
      source:
        "QuickBooks Online API — queries for PurchaseOrder / Vendor / Item / Bill",
      note: "Real API responses captured from the live sandbox. Replayed offline by recordedErp(). Not a mock.",
      capturedAt: new Date().toISOString(),
      realmId,
    },
    purchaseOrders,
    vendors,
    items,
    bills,
  };

  const outDir = path.join(process.cwd(), "db", "fixtures", "quickbooks");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "erp.json");
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);
};

main()
  .then(() => persistRotatedRefreshToken())
  .catch((err: unknown) => {
    persistRotatedRefreshToken();
    console.error("Capture failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
