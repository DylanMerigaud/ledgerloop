import type { ApprovalDecision, MatchResult, ReconResult, GlEntry } from "./schema";

/**
 * Fake ERP adapter.
 *
 * This is a STUB with a clear, real-looking interface — never a real ERP call.
 * In a production accounts-payable system the reconciliation step posts a vendor
 * bill (and its GL distribution) into the ERP; here we synthesize a deterministic
 * reference and double-entry posting so the demo's reconciliation trace is
 * concrete without any external dependency or side effect.
 *
 * (For the record: I shipped the real NetSuite integration at Pivot — the
 * SuiteTalk vendor-bill + PO-match sync. This stub deliberately stands in for
 * that so the public demo stays self-contained, free, and side-effect-free.)
 *
 * The interface is what matters: swap `fakeErp` for a `netSuiteAdapter`
 * implementing the same `ErpAdapter` and the reconciliation agent is unchanged.
 * The adapter contract below is deliberately part of the public surface — it's
 * the integration seam a reviewer should see.
 *
 * @public
 */
export interface ErpAdapter {
  readonly name: string;
  postVendorBill(req: ErpPostingRequest): Promise<ErpPostingResult>;
}

/** @public — the request shape an ERP adapter receives. */
export interface ErpPostingRequest {
  invoiceNumber: string;
  poNumber: string | null;
  vendor: string;
  amount: number;
  currency: string;
}

/** @public — what an ERP adapter returns on a successful post. */
export interface ErpPostingResult {
  /** The ERP's reference for the created bill, e.g. "NETSUITE-BILL-1042". */
  erpRef: string;
  glEntries: GlEntry[];
}

/** Standard AP double-entry: debit the expense/GR-clearing, credit AP. */
function buildGlEntries(amount: number): GlEntry[] {
  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;
  return [
    { account: "5000 · Cost of Goods / Expense", debit: rounded, credit: 0 },
    { account: "2000 · Accounts Payable", debit: 0, credit: rounded },
  ];
}

/** Deterministic pseudo-id from the invoice number, so the demo is reproducible. */
function refFor(invoiceNumber: string): string {
  let hash = 0;
  for (const ch of invoiceNumber) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const n = 1000 + (hash % 9000);
  return `NETSUITE-BILL-${n}`;
}

const fakeErp: ErpAdapter = {
  name: "fake-netsuite",
  async postVendorBill(req) {
    return {
      erpRef: refFor(req.invoiceNumber),
      glEntries: buildGlEntries(req.amount),
    };
  },
};

/**
 * Reconcile an approved/clean invoice by posting it through the ERP adapter.
 * Pure orchestration over the adapter — the Reconciliation agent calls this via
 * a tool. A blocked/duplicate invoice is never posted; it returns un-posted so
 * the trace shows the pipeline correctly refusing to pay.
 */
export async function reconcile(
  decision: ApprovalDecision,
  match: MatchResult,
  vendor: string,
  adapter: ErpAdapter = fakeErp,
): Promise<ReconResult> {
  if (decision.tier === "blocked") {
    return {
      invoiceNumber: decision.invoiceNumber,
      posted: false,
      erpRef: null,
      glEntries: [],
      currency: match.currency,
      amount: match.invoiceTotal,
      note: "Not posted — invoice is blocked (duplicate). Held for AP review.",
    };
  }

  const { erpRef, glEntries } = await adapter.postVendorBill({
    invoiceNumber: decision.invoiceNumber,
    poNumber: match.poNumber,
    vendor,
    amount: match.invoiceTotal,
    currency: match.currency,
  });

  const how =
    decision.tier === "auto"
      ? "auto-approved (straight-through)"
      : `approved at ${decision.tier} tier`;

  return {
    invoiceNumber: decision.invoiceNumber,
    posted: true,
    erpRef,
    glEntries,
    currency: match.currency,
    amount: match.invoiceTotal,
    note: `Posted to ${adapter.name} as ${erpRef} — ${how}.`,
  };
}
