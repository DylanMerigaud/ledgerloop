import type { MatchResult, ReconResult, GlEntry } from "@/lib/schema";

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

/** Standard AP double-entry: debit the expense/GR-clearing, credit AP. */
const buildGlEntries = (amount: number): GlEntry[] => {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  return [
    { account: "5000 · Cost of Goods / Expense", debit: rounded, credit: 0 },
    { account: "2000 · Accounts Payable", debit: 0, credit: rounded },
  ];
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
    note: `Posted to ${adapter.name} as ${erpRef}.`,
  };
};
