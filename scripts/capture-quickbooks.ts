/**
 * Capture the REAL QuickBooks Online purchase-order payload to a committed fixture.
 *
 * The procurement mirror of capture-bamboo.ts. It calls the live QBO API via the
 * SAME `fetchQboPurchaseOrders` the production adapter uses (OAuth2 refresh-token
 * → access token → `query select * from PurchaseOrder`), then writes the raw
 * response (plus a dated `_meta` provenance block) to
 * `db/fixtures/quickbooks/purchase-orders.json`. `recordedErp()` later replays
 * that exact payload through the same mapper. So the fixture is not a hand-written
 * mock — it is QuickBooks' own output, frozen on the date below.
 *
 * Why this exists: the QBO sandbox token/app is short-lived. Capturing the fixture
 * while it's alive means the demo (and CI, which has no key) keeps running on real
 * data afterwards, with the `_meta` stating plainly that it's a recorded snapshot.
 *
 * Run:  pnpm erp:capture   (reads creds from .env.local / .env)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@/lib/assert";
import { fetchQboPurchaseOrders, mapQboPurchaseOrders } from "@/lib/erp";
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

  console.log(`Fetching purchase orders from QBO realm ${realmId} …`);
  const raw = await fetchQboPurchaseOrders({
    clientId,
    clientSecret,
    refreshToken,
    realmId,
    accessToken: process.env.QBO_ACCESS_TOKEN,
  });

  // Validate the capture is usable BEFORE writing — a fixture that can't be mapped
  // is worse than no fixture.
  const pos = mapQboPurchaseOrders(raw);
  if (pos.length === 0) {
    console.error(
      "Mapped 0 purchase orders. The sandbox has no item-based POs to read — " +
        "create one in the QuickBooks sandbox UI (vendor + item lines) and retry.",
    );
    process.exit(1);
  }
  console.log(`Mapped OK: ${pos.length} purchase order(s).`);

  // Provenance: real data, record exactly when/where from. The realm id is written
  // (it's not a secret — it's a company id), the tokens are NOT.
  const payload = {
    _meta: {
      source: "QuickBooks Online API — query select * from PurchaseOrder",
      note: "Real API response captured from the live sandbox. Replayed offline by recordedErp(). Not a mock.",
      capturedAt: new Date().toISOString(),
      realmId,
    },
    ...(isRecord(raw) ? raw : {}),
  };

  const outDir = path.join(process.cwd(), "db", "fixtures", "quickbooks");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "purchase-orders.json");
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
