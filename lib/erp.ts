import type {
  ApprovalDecision,
  MatchResult,
  ReconResult,
  GlEntry,
} from "./schema";

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
 * A reviewer's decision on an invoice that needs human approval.
 *   "pending" — no decision yet (the run should pause and wait for a human)
 *   "approve" — a reviewer cleared it for payment
 *   "reject"  — a reviewer declined it
 */
export type HumanApproval = "pending" | "approve" | "reject";

/**
 * Reconcile an invoice by posting it through the ERP adapter — or refusing to.
 * Pure orchestration over the adapter; the reconciliation workflow step calls
 * this directly. The outcome depends on the approval decision AND, for invoices
 * that need a human, the reviewer's `humanApproval`:
 *
 *   - blocked (duplicate)            → never posted, outcome "blocked"
 *   - auto (clean, straight-through) → posted
 *   - manager/director + "pending"  → HELD, outcome "awaiting" (run pauses here)
 *   - manager/director + "approve"  → posted
 *   - manager/director + "reject"   → not posted, outcome "rejected"
 */
export async function reconcile(
  decision: ApprovalDecision,
  match: MatchResult,
  vendor: string,
  humanApproval: HumanApproval = "pending",
  adapter: ErpAdapter = fakeErp,
): Promise<ReconResult> {
  const base = {
    invoiceNumber: decision.invoiceNumber,
    currency: match.currency,
    amount: match.invoiceTotal,
  };

  // Duplicate — a control failure, never paid. No human in the loop.
  if (decision.tier === "blocked") {
    return {
      ...base,
      outcome: "blocked",
      posted: false,
      erpRef: null,
      glEntries: [],
      note: "Not posted — invoice is blocked (duplicate). Held for AP review.",
    };
  }

  const needsHuman =
    decision.tier === "manager" || decision.tier === "director";

  // Held for a human decision — the pipeline pauses here until a reviewer acts.
  if (needsHuman && humanApproval === "pending") {
    return {
      ...base,
      outcome: "awaiting",
      posted: false,
      erpRef: null,
      glEntries: [],
      note: `Awaiting ${decision.tier} approval before posting — paused for a reviewer decision.`,
    };
  }

  // A reviewer declined it.
  if (needsHuman && humanApproval === "reject") {
    return {
      ...base,
      outcome: "rejected",
      posted: false,
      erpRef: null,
      glEntries: [],
      note: "Rejected by reviewer — not posted. Returned to the vendor for correction.",
    };
  }

  // Cleared for payment: auto (clean) or human-approved exception.
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
      : `approved by reviewer at ${decision.tier} tier`;

  return {
    ...base,
    outcome: "posted",
    posted: true,
    erpRef,
    glEntries,
    note: `Posted to ${adapter.name} as ${erpRef} — ${how}.`,
  };
}
