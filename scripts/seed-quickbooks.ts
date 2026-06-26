/**
 * Seed the scenario's purchase orders into a QuickBooks Online sandbox — and tear
 * them back down. The procurement mirror of scripts/seed-bamboo.ts.
 *
 *   pnpm erp:seed     create the scenario vendors + items + POs in QBO
 *   pnpm erp:reset    delete the seeded POs and deactivate the seeded vendors/items
 *
 * Why this exists (same rationale as the HRIS seed):
 *   • Disaster recovery — the sandbox/token is short-lived. If it dies, spin a
 *     fresh sandbox and reseed; the demo POs are back, identical, in one command.
 *   • It makes the demo HONEST: the pipeline pulls the client's POs from a real
 *     ERP (lib/erp.ts) and matches invoices against them. For that to mean
 *     anything, the POs the matcher pulls must BE the scenario's POs — so we push
 *     the scenario into QBO here, then `pnpm erp:capture` records what comes back.
 *
 * Scoping (the equivalent of the HRIS SEED_DIVISION): every seeded vendor and item
 * name carries a `SEED_TAG` prefix, so `reset` finds and removes only what we
 * created and never touches the sandbox's own sample data. QBO doesn't hard-delete
 * vendors/items (you make them inactive), but POs delete cleanly — so reset deletes
 * the POs and deactivates the vendors/items.
 *
 * The QBO write recipe (verified against the live sandbox):
 *   1. query Account → resolve an expense account id (items need an ExpenseAccountRef).
 *   2. ensure each Vendor (create if absent), keyed by DisplayName.
 *   3. ensure each Item as type Service with that ExpenseAccountRef (create if absent),
 *      Name = the scenario SKU (so the pulled PO line carries the SKU as ItemRef.name).
 *   4. create each PurchaseOrder with DocNumber = the scenario poNumber and one line
 *      per scenario line, referencing the item + vendor by id.
 */
import path from "node:path";

import { z } from "zod";

import { scenarioPurchaseOrders } from "@/db/seed-data";
import { isRecord, nonNull } from "@/lib/assert";
import { qboPostEntity, qboQuery, type QboCreds } from "@/lib/erp";
import type { LineItem, PurchaseOrder } from "@/lib/schema";
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

const creds = (): QboCreds => {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const refreshToken = process.env.QBO_REFRESH_TOKEN;
  const realmId = process.env.QBO_REALM_ID;
  if (!clientId || !clientSecret || !refreshToken || !realmId) {
    console.error(
      "Missing QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REFRESH_TOKEN / QBO_REALM_ID in .env.",
    );
    process.exit(1);
  }
  return {
    clientId,
    clientSecret,
    refreshToken,
    realmId,
    accessToken: process.env.QBO_ACCESS_TOKEN,
  };
};

/**
 * The scope marker. Every seeded vendor/item name is prefixed with it (the item
 * SKU itself is the matcher key, so the tag goes only on the display surfaces we
 * own). `reset` keys off this to find what to remove. "LL" = LedgerLoop.
 */
const SEED_TAG = "LL-DEMO";
const tagged = (name: string): string => `${SEED_TAG} ${name}`;

/* ── Account resolution ─────────────────────────────────────────────────────
   Items of type Service need an ExpenseAccountRef. We don't create accounts —
   the sandbox ships a standard chart — we resolve an existing expense account by
   classification, preferring a Cost-of-Goods-Sold account, else any Expense. */
const QboAccount = z.object({
  Id: z.string(),
  Name: z.string().optional(),
  AccountType: z.string().optional(),
  Classification: z.string().optional(),
});

const resolveExpenseAccountId = async (c: QboCreds): Promise<string> => {
  const raw = await qboQuery(
    c,
    "select * from Account where Active = true maxresults 1000",
  );
  const Resp = z.object({
    QueryResponse: z
      .object({ Account: z.array(QboAccount).optional() })
      .optional(),
  });
  const parsed = Resp.safeParse(raw);
  const accounts = parsed.success
    ? (parsed.data.QueryResponse?.Account ?? [])
    : [];
  // Prefer Cost of Goods Sold (what a purchased item expenses to), else any Expense.
  const cogs = accounts.find((a) => a.AccountType === "Cost of Goods Sold");
  const expense = cogs ?? accounts.find((a) => a.Classification === "Expense");
  if (!expense) {
    throw new Error(
      "No expense / COGS account found in the sandbox to attach items to.",
    );
  }
  return expense.Id;
};

/* ── Vendor + Item ensure (idempotent, keyed by name) ───────────────────────*/
const QboNamedEntity = z.object({
  Id: z.string(),
  DisplayName: z.string().optional(),
  Name: z.string().optional(),
});

const ensureVendor = async (c: QboCreds, vendor: string): Promise<string> => {
  const name = tagged(vendor);
  const existing = await qboQuery(
    c,
    `select * from Vendor where DisplayName = '${escapeQuery(name)}'`,
  );
  const found = firstEntity(existing, "Vendor");
  if (found) return found;
  const created = await qboPostEntity(c, "vendor", { DisplayName: name });
  return entityId(created, "Vendor");
};

const ensureItem = async (
  c: QboCreds,
  sku: string,
  expenseAccountId: string,
): Promise<string> => {
  // The item NAME is the scenario SKU — that's what the matcher joins on once the
  // PO is pulled back (mapQboPurchaseOrders keys sku on ItemRef.name).
  const existing = await qboQuery(
    c,
    `select * from Item where Name = '${escapeQuery(sku)}'`,
  );
  const found = firstEntity(existing, "Item");
  if (found) return found;
  const created = await qboPostEntity(c, "item", {
    Name: sku,
    Type: "Service",
    ExpenseAccountRef: { value: expenseAccountId },
  });
  return entityId(created, "Item");
};

/* ── PO create ──────────────────────────────────────────────────────────────*/
const buildPoLine = (
  line: LineItem,
  itemId: string,
): Record<string, unknown> => ({
  DetailType: "ItemBasedExpenseLineDetail",
  Amount: line.amount,
  Description: line.description,
  ItemBasedExpenseLineDetail: {
    ItemRef: { value: itemId },
    Qty: line.qty,
    UnitPrice: line.unitPrice,
  },
});

const createPo = async (
  c: QboCreds,
  po: PurchaseOrder,
  vendorId: string,
  itemIds: Map<string, string>,
): Promise<void> => {
  const Line = po.lineItems.map((l) =>
    buildPoLine(l, nonNull(itemIds.get(l.sku), `item ${l.sku} was ensured`)),
  );
  await qboPostEntity(c, "purchaseorder", {
    DocNumber: po.poNumber,
    VendorRef: { value: vendorId },
    Line,
  });
};

/* ── Existing seeded POs (for idempotency + reset) ──────────────────────────*/
const seededPoIds = async (
  c: QboCreds,
  docNumbers: string[],
): Promise<{ id: string; docNumber: string; syncToken: string }[]> => {
  const raw = await qboQuery(c, "select * from PurchaseOrder maxresults 1000");
  const Resp = z.object({
    QueryResponse: z
      .object({
        PurchaseOrder: z
          .array(
            z.object({
              Id: z.string(),
              DocNumber: z.string().optional(),
              SyncToken: z.string(),
            }),
          )
          .optional(),
      })
      .optional(),
  });
  const parsed = Resp.safeParse(raw);
  const pos = parsed.success
    ? (parsed.data.QueryResponse?.PurchaseOrder ?? [])
    : [];
  const wanted = new Set(docNumbers);
  return pos
    .filter((p) => p.DocNumber && wanted.has(p.DocNumber))
    .map((p) => ({
      id: p.Id,
      docNumber: nonNull(p.DocNumber, "filtered on DocNumber"),
      syncToken: p.SyncToken,
    }));
};

/* ── Commands ───────────────────────────────────────────────────────────────*/
const seed = async (): Promise<void> => {
  const c = creds();
  const pos = scenarioPurchaseOrders();
  const docNumbers = pos.map((p) => p.poNumber);

  const already = await seededPoIds(c, docNumbers);
  if (already.length > 0) {
    console.error(
      `${already.length} scenario PO(s) already in QBO (${already.map((a) => a.docNumber).join(", ")}). ` +
        `Run "pnpm erp:reset" first to avoid duplicates.`,
    );
    process.exit(1);
  }

  console.log("Resolving an expense account for the seeded items …");
  const expenseAccountId = await resolveExpenseAccountId(c);

  console.log(`Seeding ${pos.length} purchase order(s) into QBO …`);
  for (const po of pos) {
    const vendorId = await ensureVendor(c, po.vendor);
    const itemIds = new Map<string, string>();
    for (const line of po.lineItems) {
      if (!itemIds.has(line.sku)) {
        itemIds.set(line.sku, await ensureItem(c, line.sku, expenseAccountId));
      }
    }
    await createPo(c, po, vendorId, itemIds);
    console.log(
      `  + ${po.poNumber} — ${po.vendor} (${po.lineItems.length} line${po.lineItems.length === 1 ? "" : "s"})`,
    );
  }

  console.log(
    `\nDone. ${pos.length} purchase order(s) seeded. ` +
      `Run "pnpm erp:capture" to record them into the recorded fixture.`,
  );
};

const reset = async (): Promise<void> => {
  const c = creds();
  const docNumbers = scenarioPurchaseOrders().map((p) => p.poNumber);
  const targets = await seededPoIds(c, docNumbers);
  if (targets.length === 0) {
    console.log("Nothing to reset — no scenario POs found in QBO.");
    return;
  }
  console.log(`Deleting ${targets.length} seeded PO(s):`);
  let failed = 0;
  for (const t of targets) {
    try {
      await qboPostEntity(c, "purchaseorder?operation=delete", {
        Id: t.id,
        SyncToken: t.syncToken,
      });
      console.log(`  - ${t.docNumber} (${t.id})`);
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`  ! could not delete ${t.docNumber}: ${reason}`);
    }
  }
  // Vendors/items aren't hard-deleted by QBO; leaving them inactive-able is fine
  // (they're tagged and harmless), so we stop at the POs — re-seeding reuses them.
  console.log(
    failed === 0
      ? `Removed all ${targets.length}. (Seeded vendors/items are left in place, tagged "${SEED_TAG}".)`
      : `${failed} could not be deleted (see above).`,
  );
};

/* ── small helpers ──────────────────────────────────────────────────────────*/
/** QBO query strings are single-quoted; escape embedded quotes. */
const escapeQuery = (s: string): string => s.replace(/'/g, "\\'");

const firstEntity = (raw: unknown, entity: string): string | null => {
  // A query response is `{ QueryResponse: { <Entity>: [...], maxResults, ... } }`.
  // The sibling numeric fields (startPosition/maxResults/totalCount) mean a strict
  // record parse fails, so read the entity array directly off QueryResponse.
  if (!isRecord(raw) || !isRecord(raw.QueryResponse)) return null;
  const rows = z.array(QboNamedEntity).safeParse(raw.QueryResponse[entity]);
  if (!rows.success) return null;
  return rows.data[0]?.Id ?? null;
};

const entityId = (raw: unknown, entity: string): string => {
  // A create response is `{ <Entity>: { Id, … }, time: "…" }`. The sibling `time`
  // string means a strict record parse fails, so read the entity field directly
  // off the object via a per-entity schema.
  if (!isRecord(raw)) {
    throw new Error(`QBO create ${entity} returned a non-object response.`);
  }
  const parsed = z.object({ Id: z.string() }).safeParse(raw[entity]);
  if (!parsed.success) {
    throw new Error(`QBO create ${entity} returned no Id.`);
  }
  return parsed.data.Id;
};

const main = async (): Promise<void> => {
  loadEnv();
  const cmd = process.argv[2];
  if (cmd === "reset") {
    await reset();
  } else if (cmd === "seed" || cmd === undefined) {
    await seed();
  } else {
    console.error(`Unknown command "${cmd}". Use: seed | reset`);
    process.exit(1);
  }
};

main()
  .then(() => persistRotatedRefreshToken())
  .catch((err: unknown) => {
    // Persist any rotation even on failure — the token may have rotated before
    // the error, and we don't want to lose it.
    persistRotatedRefreshToken();
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
