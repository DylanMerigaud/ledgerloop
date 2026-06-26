import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { env } from "@/lib/env";
import {
  PurchaseOrder,
  type MatchResult,
  type ReconResult,
  type GlEntry,
  type VendorBill,
  type PurchaseOrder as TPurchaseOrder,
} from "@/lib/schema";

/**
 * Fake ERP adapter.
 *
 * This is a STUB with a clear, real-looking interface — never a real ERP call.
 * In a production accounts-payable system the reconciliation step posts a vendor
 * bill (and its GL distribution) into the ERP (NetSuite, etc.); here we
 * synthesize a deterministic reference and double-entry posting so the demo's
 * reconciliation trace is concrete without any external dependency or side
 * effect. The public demo stays self-contained and side-effect-free.
 *
 * The interface is what matters: swap `fakeErp` for a `netSuiteAdapter`
 * implementing the same `ErpAdapter` and the reconciliation step is unchanged.
 * The adapter contract below is deliberately part of the public surface — it's
 * the integration seam a reviewer should see.
 *
 * @public
 */
export type ErpAdapter = {
  readonly name: string;
  postVendorBill(req: ErpPostingRequest): Promise<ErpPostingResult>;
};

/** @public — the request shape an ERP adapter receives. */
export type ErpPostingRequest = {
  invoiceNumber: string;
  poNumber: string | null;
  vendor: string;
  amount: number;
  currency: string;
};

/** @public — what an ERP adapter returns on a successful post. */
export type ErpPostingResult = {
  /** The ERP's reference for the created bill, e.g. "NETSUITE-BILL-1042". */
  erpRef: string;
  glEntries: GlEntry[];
};

/** The GL accounts the AP double-entry books to (and the bill's expense line). */
const EXPENSE_ACCOUNT = "5000 · Cost of Goods / Expense";
const AP_ACCOUNT = "2000 · Accounts Payable";

/** Standard AP double-entry: debit the expense/GR-clearing, credit AP. */
const buildGlEntries = (amount: number): GlEntry[] => {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  return [
    { account: EXPENSE_ACCOUNT, debit: rounded, credit: 0 },
    { account: AP_ACCOUNT, debit: 0, credit: rounded },
  ];
};

/**
 * Build the vendor-bill payload the ERP write-back WOULD post once an invoice
 * clears — pure, no network, no side effect. It mirrors the real QuickBooks bill
 * the seed posts (DocNumber + vendor + a single account-based expense line for the
 * total). Shown on the reconciliation trace as a DRY-RUN: the concrete artifact a
 * real post would create, never actually sent (the write-back is a stub).
 *
 * @public — part of the ERP seam: a real adapter would send exactly this.
 */
export const buildVendorBill = (
  match: MatchResult,
  vendor: string,
): VendorBill => {
  return {
    docNumber: match.invoiceNumber,
    vendor,
    poNumber: match.poNumber,
    currency: match.currency,
    expenseAccount: EXPENSE_ACCOUNT,
    total: match.invoiceTotal,
  };
};

/** Deterministic pseudo-id from the invoice number, so the demo is reproducible. */
const refFor = (invoiceNumber: string): string => {
  let hash = 0;
  for (const ch of invoiceNumber) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const n = 1000 + (hash % 9000);
  return `NETSUITE-BILL-${n}`;
};

const fakeErp: ErpAdapter = {
  name: "fake-netsuite",
  // Synchronous stub, but the adapter contract is async (a real ERP post is) — so
  // return a resolved promise instead of an `async` method with no await.
  postVendorBill(req) {
    return Promise.resolve({
      erpRef: refFor(req.invoiceNumber),
      glEntries: buildGlEntries(req.amount),
    });
  },
};

/**
 * How the approval workflow resolved for this invoice, as the engine reports it:
 *   "blocked"  — a duplicate; a control failure, never routed or paid
 *   "awaiting" — one or more approval gates are still pending a human
 *   "rejected" — an approver declined; not posted
 *   "posted"   — every active gate approved (or none applied); cleared to post
 */
export type ApprovalOutcome = "posted" | "awaiting" | "rejected" | "blocked";

/**
 * Reconcile an invoice by posting it through the ERP adapter — or refusing to —
 * driven by the approval workflow's OUTCOME. The workflow engine has already
 * resolved who needed to sign off and whether they did; reconciliation just acts
 * on the result. Pure orchestration over the adapter; the reconciliation workflow
 * step calls this directly.
 *
 *   - blocked  → never posted (duplicate control failure)
 *   - awaiting → HELD, the run pauses for the pending approver(s)
 *   - rejected → not posted, returned to the vendor
 *   - posted   → booked to the ERP
 */
export const reconcileFromOutcome = async (
  outcome: ApprovalOutcome,
  match: MatchResult,
  vendor: string,
  adapter: ErpAdapter = fakeErp,
): Promise<ReconResult> => {
  const base = {
    invoiceNumber: match.invoiceNumber,
    currency: match.currency,
    amount: match.invoiceTotal,
  };

  if (outcome === "blocked") {
    return {
      ...base,
      outcome: "blocked",
      posted: false,
      erpRef: null,
      glEntries: [],
      note: "Not posted — invoice is blocked (duplicate). Held for AP review.",
      vendorBill: null,
    };
  }

  if (outcome === "awaiting") {
    return {
      ...base,
      outcome: "awaiting",
      posted: false,
      erpRef: null,
      glEntries: [],
      note: "Awaiting approval before posting — paused for the pending reviewer(s).",
      vendorBill: null,
    };
  }

  if (outcome === "rejected") {
    return {
      ...base,
      outcome: "rejected",
      posted: false,
      erpRef: null,
      glEntries: [],
      note: "Rejected by an approver — not posted. Returned to the vendor for correction.",
      vendorBill: null,
    };
  }

  // posted — every active gate approved (or it was a clean straight-through run).
  const { erpRef, glEntries } = await adapter.postVendorBill({
    invoiceNumber: match.invoiceNumber,
    poNumber: match.poNumber,
    vendor,
    amount: match.invoiceTotal,
    currency: match.currency,
  });

  return {
    ...base,
    outcome: "posted",
    posted: true,
    erpRef,
    glEntries,
    note: `Cleared to post as ${erpRef} (write-back is a dry-run — the bill below is what we'd send).`,
    // The dry-run payload: the exact bill a real write-back would POST. Built
    // deterministically here; never sent (the write-back is a stub).
    vendorBill: buildVendorBill(match, vendor),
  };
};

/* ══════════════════════════════════════════════════════════════════════════ *
 *  PULL side — read a client's existing purchase orders from their ERP
 * ══════════════════════════════════════════════════════════════════════════ *
 *
 * The procurement mirror of the HRIS seam (`lib/hris.ts`). Onboarding reads a
 * client's org from BambooHR; the pipeline reads a client's open purchase orders
 * from their ERP (QuickBooks Online here) and matches incoming invoices against
 * them. PULL only — the bill we post back (the `reconcileFromOutcome` side above)
 * is the deterministic stub; importing the client's REAL POs is the interesting
 * half, because it's the same "connect their system, read their data" story.
 *
 * Same discipline as HRIS, two implementations behind one interface:
 *   • `liveQuickBooksErp(creds)` — real SuiteTalk-style HTTP against the QBO API,
 *     scoped to the client's company ("realm"). OAuth2 with a long-lived refresh
 *     token; we mint a short-lived access token per pull.
 *   • `recordedErp()`           — replays a captured fixture from disk through the
 *     SAME mapper, so recorded == live and the demo runs with no key (CI included).
 *
 * Everything QuickBooks-specific (the `QueryResponse.PurchaseOrder` wire shape,
 * the OAuth2 token endpoint) stops at this file. `pullPurchaseOrders()` returns
 * the internal `PurchaseOrder[]` the matcher already consumes — swap QBO for a
 * `netSuiteErp` implementing the same `PoSourceAdapter` and nothing downstream
 * changes.
 */

/** A vendor as the client's ERP knows it — the master record, normalised. */
export type ErpVendor = {
  name: string;
  active: boolean;
};

/** An item as the client's ERP catalog knows it — `sku` is the matcher join key. */
export type ErpItem = {
  sku: string;
  active: boolean;
};

/** A bill already posted (and paid) in the ERP — for historical duplicate detection. */
export type ErpPostedBill = {
  vendor: string;
  /** The vendor's invoice/document number on the posted bill. */
  docNumber: string;
};

/**
 * @public — the read seam: a client's ERP, read-only. Beyond the open POs, it
 * exposes the master data an AP control checks an incoming invoice against — the
 * vendor list, the item catalog, and the already-posted bills. Each method throws
 * only on transport/parse failure; callers degrade gracefully. Swap QBO for a
 * `netSuiteErp` implementing this and nothing downstream changes (cf. HRIS).
 */
export type PoSourceAdapter = {
  readonly name: string;
  /** Pull the client's purchase orders, normalised. */
  pullPurchaseOrders(): Promise<TPurchaseOrder[]>;
  /** Pull the client's vendor master (for the inactive-vendor control). */
  pullVendors(): Promise<ErpVendor[]>;
  /** Pull the client's item catalog (for the off-catalog SKU control). */
  pullItems(): Promise<ErpItem[]>;
  /** Pull bills already posted in the ERP (for the already-paid duplicate control). */
  pullPostedBills(): Promise<ErpPostedBill[]>;
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  The vendor's wire shape (QuickBooks Online) — confined to this file
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What QBO's `query?query=select * from PurchaseOrder` returns, validated with
 * Zod because it's parsed JSON (so the mapper reads it without an `as` cast).
 * QBO omits empty fields entirely (rather than null), and numbers come back as
 * numbers, so every field the mapper doesn't strictly require is optional and read
 * defensively. Unknown extra fields are ignored. A reference in QBO is a
 * `{ value, name? }` pair (the id is `value`); a line carries its item, qty and
 * unit price under `ItemBasedExpenseLineDetail`. Only `ItemBasedExpenseLine` rows
 * carry an item we can match on — other line types (e.g. a subtotal) are dropped.
 */
const QboRef = z.object({ value: z.string(), name: z.string().optional() });

const QboItemDetail = z.object({
  ItemRef: QboRef.optional(),
  Qty: z.number().optional(),
  UnitPrice: z.number().optional(),
});

const QboLine = z.object({
  DetailType: z.string().optional(),
  Amount: z.number().optional(),
  Description: z.string().optional(),
  ItemBasedExpenseLineDetail: QboItemDetail.optional(),
});

const QboPurchaseOrder = z.object({
  Id: z.string().optional(),
  DocNumber: z.string().optional(),
  VendorRef: QboRef.optional(),
  CurrencyRef: QboRef.optional(),
  TotalAmt: z.number().optional(),
  Line: z.array(QboLine).optional(),
});

const QboPoResponse = z.object({
  QueryResponse: z
    .object({ PurchaseOrder: z.array(QboPurchaseOrder).optional() })
    .optional(),
});

/* ────────────────────────────────────────────────────────────────────────── *
 *  The shared mapper — QBO shape → internal PurchaseOrder[]
 * ────────────────────────────────────────────────────────────────────────── */

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Turn a raw QBO PurchaseOrder query payload into our `PurchaseOrder[]`. The ONE
 * place QBO's shape becomes our shape; it runs identically on live bytes and on
 * replayed fixture bytes, so the two adapters can't drift. Pure and synchronous —
 * easy to test against the captured fixture.
 *
 * Real-world cleanups, each deliberate:
 *   1. A PO needs a vendor and at least one matchable (item) line to be usable by
 *      the matcher — POs missing either are dropped, not invented. (QBO can carry
 *      account-based or subtotal lines that have no item.)
 *   2. The internal `poNumber` is QBO's human `DocNumber`, falling back to the
 *      internal `Id` when a PO has no doc number — so it always has a stable key.
 *   3. The matcher joins lines on `sku`, and QBO's PO line carries the item only as
 *      `ItemRef.{value:id, name}` — the real SKU lives on the Item entity, not the
 *      line. So we key on the item NAME (which the seed sets to the SKU), not the
 *      numeric id, so a pulled PO line lines up with the invoice line by SKU. The
 *      longer `Line.Description` becomes the human description.
 *   4. Currency falls back to USD when QBO omits `CurrencyRef` (a single-currency
 *      sandbox/company often does), keeping the value valid against the schema.
 *   5. Each line's `amount` is taken from QBO when present, else recomputed from
 *      qty × unitPrice, so the line is internally consistent for the matcher.
 */
export const mapQboPurchaseOrders = (raw: unknown): TPurchaseOrder[] => {
  const parsed = QboPoResponse.safeParse(raw);
  const rows = parsed.success
    ? (parsed.data.QueryResponse?.PurchaseOrder ?? [])
    : [];

  const out: TPurchaseOrder[] = [];
  for (const po of rows) {
    const vendor = po.VendorRef?.name?.trim() ?? "";
    const poNumber = po.DocNumber?.trim() || po.Id?.trim() || "";
    const currency = po.CurrencyRef?.value.trim() || "USD";

    // Keep only item-based lines that carry an item NAME — that name is the SKU
    // the matcher joins on (see cleanup 3). Map each to our LineItem shape.
    const lineItems = (po.Line ?? [])
      .filter((l) => (l.ItemBasedExpenseLineDetail?.ItemRef?.name ?? "").trim())
      .map((l) => {
        const d = l.ItemBasedExpenseLineDetail;
        const item = d?.ItemRef;
        const sku = item?.name?.trim() ?? "";
        const description = (l.Description?.trim() || item?.name?.trim()) ?? "";
        const qty = d?.Qty ?? 0;
        const unitPrice = d?.UnitPrice ?? 0;
        const amount = l.Amount ?? round2(qty * unitPrice);
        return { sku, description, qty, unitPrice, amount };
      });

    // A PO with no vendor or no matchable line can't drive a 2/3-way match —
    // skip it rather than emit something the schema would reject or the matcher
    // can't use.
    if (!vendor || !poNumber || lineItems.length === 0) continue;

    const total =
      po.TotalAmt ?? round2(lineItems.reduce((s, l) => s + l.amount, 0));

    // QBO doesn't carry our internal buying department on a PO, so it's "" (no
    // department → the invoice routes normally; a department-scoped gate just
    // doesn't fire). The seeded POs set it where the demo needs the gate to fire.
    const candidate = {
      poNumber,
      vendor,
      currency,
      lineItems,
      total,
      department: "",
    };
    const result = PurchaseOrder.safeParse(candidate);
    if (result.success) out.push(result.data);
  }
  return out;
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  Master-data wire shapes + mappers (QBO Vendor / Item / Bill)
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * Same discipline as the PO mapper: Zod at the JSON boundary, defensive reads,
 * one mapper shared by live + recorded. QBO marks records active/inactive with an
 * `Active` boolean (absent → treated as active).
 */

const QboVendorRow = z.object({
  DisplayName: z.string().optional(),
  Active: z.boolean().optional(),
});
const QboVendorResponse = z.object({
  QueryResponse: z
    .object({ Vendor: z.array(QboVendorRow).optional() })
    .optional(),
});

/** Raw QBO Vendor query payload → internal vendor master.
 *  QBO renames a deactivated name-list entity to "<name> (deleted)"; we strip that
 *  suffix so the normalised vendor name still matches the invoice's vendor. */
export const mapQboVendors = (raw: unknown): ErpVendor[] => {
  const parsed = QboVendorResponse.safeParse(raw);
  const rows = parsed.success ? (parsed.data.QueryResponse?.Vendor ?? []) : [];
  const out: ErpVendor[] = [];
  for (const v of rows) {
    const raw = v.DisplayName?.trim();
    if (!raw) continue;
    const name = raw.replace(/\s*\(deleted\)\s*$/i, "");
    out.push({ name, active: v.Active ?? true });
  }
  return out;
};

const QboItemRow = z.object({
  Name: z.string().optional(),
  Active: z.boolean().optional(),
});
const QboItemResponse = z.object({
  QueryResponse: z.object({ Item: z.array(QboItemRow).optional() }).optional(),
});

/** Raw QBO Item query payload → internal catalog. `sku` is the item Name (the
 *  matcher's join key, the same value the PO mapper keys lines on). */
export const mapQboItems = (raw: unknown): ErpItem[] => {
  const parsed = QboItemResponse.safeParse(raw);
  const rows = parsed.success ? (parsed.data.QueryResponse?.Item ?? []) : [];
  const out: ErpItem[] = [];
  for (const i of rows) {
    const sku = i.Name?.trim();
    if (!sku) continue;
    out.push({ sku, active: i.Active ?? true });
  }
  return out;
};

const QboBillRow = z.object({
  DocNumber: z.string().optional(),
  VendorRef: QboRef.optional(),
});
const QboBillResponse = z.object({
  QueryResponse: z.object({ Bill: z.array(QboBillRow).optional() }).optional(),
});

/** Raw QBO Bill query payload → posted bills (only those with a vendor + number,
 *  which is what the historical-duplicate control keys on). */
export const mapQboPostedBills = (raw: unknown): ErpPostedBill[] => {
  const parsed = QboBillResponse.safeParse(raw);
  const rows = parsed.success ? (parsed.data.QueryResponse?.Bill ?? []) : [];
  const out: ErpPostedBill[] = [];
  for (const b of rows) {
    const vendor = b.VendorRef?.name?.trim();
    const docNumber = b.DocNumber?.trim();
    if (!vendor || !docNumber) continue;
    out.push({ vendor, docNumber });
  }
  return out;
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  Live adapter — real QuickBooks Online
 * ────────────────────────────────────────────────────────────────────────── */

/** @public — credentials a live QBO adapter needs (OAuth2 + the company realm). */
export type QboCreds = {
  clientId: string;
  clientSecret: string;
  /** Long-lived refresh token; we mint a short-lived access token per pull. */
  refreshToken: string;
  /** The company id ("realm") the query is scoped to. */
  realmId: string;
  /**
   * An already-minted access token to use as-is, skipping the refresh exchange.
   * Optional — handy when you have a fresh token from the OAuth Playground (good
   * ≈1h) and want to avoid the refresh-token rotation dance entirely.
   */
  accessToken?: string;
};

/** QBO's sandbox API host. (Production would be quickbooks.api.intuit.com.) */
const QBO_API_BASE = "https://sandbox-quickbooks.api.intuit.com";
const QBO_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

/**
 * Exchange the long-lived refresh token for a short-lived access token. QBO
 * access tokens expire in ≈1h, so a stored access token would be stale; we mint
 * one from the refresh token (HTTP Basic with the app's client id/secret, the
 * OAuth2 refresh-token grant) and cache it in-module until just before expiry, so
 * a seed run making many calls doesn't re-mint on every request.
 */
const QBO_MINOR_VERSION = "70";
let tokenCache: { token: string; expiresAt: number } | null = null;

/**
 * QBO ROTATES the refresh token: each successful refresh response carries a NEW
 * refresh_token and eventually invalidates the old one. A long-running setup must
 * persist the rotated value or the next process fails with a 401. The adapter
 * pulls once so it doesn't matter there, but the seed/capture scripts read this
 * after running and write it back to .env (see scripts/*-quickbooks.ts).
 */
let rotatedRefreshToken: string | null = null;
export const qboRotatedRefreshToken = (): string | null => rotatedRefreshToken;

const qboAccessToken = async (creds: QboCreds): Promise<string> => {
  // A directly-supplied access token wins — no refresh exchange (avoids the
  // refresh-token rotation entirely while the token is fresh).
  if (creds.accessToken) return creds.accessToken;
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString(
    "base64",
  );
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `QBO token refresh failed: HTTP ${res.status} ${res.statusText}. ` +
        "The refresh token is invalid or expired (QBO rotates it) — mint a fresh " +
        "one from the OAuth 2.0 Playground and update QBO_REFRESH_TOKEN.",
    );
  }
  const json: unknown = await res.json();
  const Token = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().optional(),
  });
  const parsed = Token.safeParse(json);
  if (!parsed.success) {
    throw new Error("QBO token refresh returned no access_token.");
  }
  if (
    parsed.data.refresh_token &&
    parsed.data.refresh_token !== creds.refreshToken
  ) {
    rotatedRefreshToken = parsed.data.refresh_token;
  }
  // Cache until 60s before expiry (default 3600s if QBO omits expires_in).
  const ttlMs = (parsed.data.expires_in ?? 3600) * 1000;
  tokenCache = {
    token: parsed.data.access_token,
    expiresAt: Date.now() + ttlMs - 60_000,
  };
  return parsed.data.access_token;
};

const qboUrl = (creds: QboCreds, pathPart: string): string => {
  const sep = pathPart.includes("?") ? "&" : "?";
  return `${QBO_API_BASE}/v3/company/${creds.realmId}/${pathPart}${sep}minorversion=${QBO_MINOR_VERSION}`;
};

/**
 * Run a SuiteQL-style read query against QBO. Exported so the seed/capture scripts
 * (re)use the exact token + request path the live adapter uses.
 */
export const qboQuery = async (
  creds: QboCreds,
  query: string,
): Promise<unknown> => {
  const accessToken = await qboAccessToken(creds);
  const url = qboUrl(creds, `query?query=${encodeURIComponent(query)}`);
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`QBO query failed: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
};

/**
 * Create (or operate on) a QBO entity by POSTing a JSON body. `entityPath` is the
 * entity name, optionally with a query suffix (e.g. "purchaseorder?operation=delete").
 * Exported for the seed script; the read-only adapter never calls it.
 */
export const qboPostEntity = async (
  creds: QboCreds,
  entityPath: string,
  body: Record<string, unknown>,
): Promise<unknown> => {
  const accessToken = await qboAccessToken(creds);
  const url = qboUrl(creds, entityPath);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `QBO ${entityPath} failed: HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return res.json();
};

/* The raw queries, exported so the capture script records the exact payloads. */
export const fetchQboPurchaseOrders = (creds: QboCreds): Promise<unknown> =>
  qboQuery(creds, "select * from PurchaseOrder maxresults 100");
export const fetchQboVendors = (creds: QboCreds): Promise<unknown> =>
  // QBO returns only active rows by default; the inactive-vendor control needs the
  // deactivated ones too, so ask for both explicitly.
  qboQuery(
    creds,
    "select * from Vendor where Active in (true, false) maxresults 1000",
  );
export const fetchQboItems = (creds: QboCreds): Promise<unknown> =>
  qboQuery(creds, "select * from Item maxresults 1000");
export const fetchQboBills = (creds: QboCreds): Promise<unknown> =>
  qboQuery(creds, "select * from Bill maxresults 1000");

/**
 * Live QuickBooks Online adapter.
 *
 * @public — the integration seam: swap this for a `netSuiteErp` implementing
 * `PoSourceAdapter` and nothing downstream changes (cf. the HRIS seam).
 */
export const liveQuickBooksErp = (creds: QboCreds): PoSourceAdapter => {
  return {
    name: "quickbooks",
    async pullPurchaseOrders() {
      return mapQboPurchaseOrders(await fetchQboPurchaseOrders(creds));
    },
    async pullVendors() {
      return mapQboVendors(await fetchQboVendors(creds));
    },
    async pullItems() {
      return mapQboItems(await fetchQboItems(creds));
    },
    async pullPostedBills() {
      return mapQboPostedBills(await fetchQboBills(creds));
    },
  };
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  Recorded adapter — replays the captured QBO payload
 * ────────────────────────────────────────────────────────────────────────── */

const ERP_FIXTURE_PATH = path.join(
  process.cwd(),
  "db",
  "fixtures",
  "quickbooks",
  "erp.json",
);

/**
 * The recorded fixture holds the raw QBO query response for each entity under its
 * own key (`purchaseOrders`/`vendors`/`items`/`bills`), captured from the live
 * sandbox by `pnpm erp:capture`. Validated as records so a missing/garbled entity
 * yields an empty list rather than throwing.
 */
const ErpFixture = z.object({
  purchaseOrders: z.unknown().optional(),
  vendors: z.unknown().optional(),
  items: z.unknown().optional(),
  bills: z.unknown().optional(),
});

/**
 * Replays the captured QBO payloads from disk through the SAME mappers the live
 * adapter uses, so recorded and live read the exact same data. The fixture is a
 * REAL capture (see `scripts/capture-quickbooks.ts`) — its `_meta` records
 * when/where from.
 */
export const recordedErp = (
  fixturePath: string = ERP_FIXTURE_PATH,
): PoSourceAdapter => {
  // Read + parse once; each method maps its slice. Sync read, async contract.
  const load = (): z.infer<typeof ErpFixture> => {
    const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    return ErpFixture.parse(raw);
  };
  return {
    name: "quickbooks (recorded)",
    pullPurchaseOrders() {
      return Promise.resolve(mapQboPurchaseOrders(load().purchaseOrders));
    },
    pullVendors() {
      return Promise.resolve(mapQboVendors(load().vendors));
    },
    pullItems() {
      return Promise.resolve(mapQboItems(load().items));
    },
    pullPostedBills() {
      return Promise.resolve(mapQboPostedBills(load().bills));
    },
  };
};

/* ────────────────────────────────────────────────────────────────────────── *
 *  The single decision point
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The ONLY place the live-vs-recorded choice is made. Live when all four QBO
 * values are present (you, with the sandbox app); recorded — the captured
 * fixture — otherwise (CI, a teammate, after the sandbox expires). Everything
 * else calls this and is oblivious, the same discipline as `defaultHris()`.
 *
 * @public — the entry point the pipeline uses to read a client's POs.
 */
export const defaultErp = (): PoSourceAdapter => {
  const { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REFRESH_TOKEN, QBO_REALM_ID } =
    env;
  if (QBO_CLIENT_ID && QBO_CLIENT_SECRET && QBO_REFRESH_TOKEN && QBO_REALM_ID) {
    return liveQuickBooksErp({
      clientId: QBO_CLIENT_ID,
      clientSecret: QBO_CLIENT_SECRET,
      refreshToken: QBO_REFRESH_TOKEN,
      realmId: QBO_REALM_ID,
    });
  }
  return recordedErp();
};
