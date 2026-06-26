import { DEFAULT_TOLERANCES, type MatchTolerances } from "@/lib/client-profile";
import type {
  Invoice,
  PurchaseOrder,
  GoodsReceipt,
  MatchResult,
  MatchException,
} from "@/lib/schema";

/**
 * The 2/3-way matcher — the deterministic core of the demo.
 *
 * This is a PURE function (no I/O, no LLM): given an invoice, its purchase order,
 * and an optional goods receipt, it decides whether the three documents
 * reconcile and, if not, exactly which lines diverge and by how much. The
 * matching workflow step calls this directly, as do the unit tests — so the tests
 * measure the real pipeline, not a reimplementation. The verdict is deterministic
 * by design: a payment decision must be exact and repeatable, never a model's
 * guess, which is also what lets the seeded edge cases fire reliably in a live
 * demo. (The one LLM in the pipeline is the exception investigator, downstream.)
 *
 * "2-way"  = invoice ↔ PO            (price + quantity ordered)
 * "3-way"  = invoice ↔ PO ↔ receipt  (also: did we actually receive it?)
 */
const round2 = (n: number): number => {
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/** Relative difference |a − b| / max(|b|, ε), guarding divide-by-zero. */
const relDiff = (actual: number, expected: number): number => {
  const denom = Math.max(Math.abs(expected), 1e-9);
  return Math.abs(actual - expected) / denom;
};

const pct = (n: number): string => {
  return `${(n * 100).toFixed(1)}%`;
};

const money = (n: number, currency: string): string => {
  const v = round2(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
};

export type MatchInput = {
  invoice: Invoice;
  purchaseOrder: PurchaseOrder | null;
  goodsReceipt: GoodsReceipt | null;
  /**
   * Invoice numbers already seen in this vendor's ledger. If the invoice under
   * test is in here, it's a duplicate (block it — never pay an invoice twice).
   * The pipeline passes the seeded ledger; the check stays pure and testable.
   */
  priorInvoiceNumbers?: readonly string[];
  /**
   * The client's master data, PULLED from their ERP (lib/erp.ts). All optional —
   * when absent, those controls simply don't fire, so the matcher (and every
   * existing test) behaves exactly as before. Keeping the matcher pure: the I/O
   * happens in the read layer, the comparison stays here.
   *
   *   • `postedBillKeys`  — "vendor invoiceNumber" of bills ALREADY posted in the
   *     ERP. A hit means this invoice was already paid (the real, historical
   *     duplicate — distinct from `priorInvoiceNumbers`, which is only what's been
   *     seen in THIS run's queue).
   *   • `inactiveVendors` — vendor names marked inactive in the ERP. A bill from
   *     one is a control/fraud signal, not a pricing question.
   *   • `catalogSkus`     — the set of SKUs the ERP item catalog knows. An invoiced
   *     SKU outside it never appears in the client's records.
   */
  postedBillKeys?: ReadonlySet<string>;
  inactiveVendors?: ReadonlySet<string>;
  catalogSkus?: ReadonlySet<string>;
};

/** The key under which a (vendor, invoiceNumber) pair is recorded for ERP dup detection. */
export const billKey = (vendor: string, invoiceNumber: string): string =>
  `${vendor}	${invoiceNumber}`;

/**
 * Run the match. Returns a fully-populated `MatchResult` whose `verdict` drives
 * the workflow's conditional routing:
 *   - "duplicate" → blocked (no payment)
 *   - "exception" → routed to Approval
 *   - "clean"     → straight-through to Reconciliation
 */
export const runMatch = (
  input: MatchInput,
  tolerances: MatchTolerances = DEFAULT_TOLERANCES,
): MatchResult => {
  const {
    invoice,
    purchaseOrder,
    goodsReceipt,
    priorInvoiceNumbers = [],
    postedBillKeys,
    inactiveVendors,
    catalogSkus,
  } = input;
  const currency = invoice.currency;
  // The buying department comes from the PO (the internal team that ordered); "" when
  // there's no PO. Carried into the result so a department-scoped approval gate routes.
  const department = purchaseOrder?.department ?? "";
  const matchType: MatchResult["matchType"] = goodsReceipt
    ? "three_way"
    : "two_way";

  // A blocked-duplicate result, shared by the two duplicate controls below. Both
  // are control failures (never a pricing question), so they short-circuit before
  // any line reasoning and yield the same blocking verdict.
  const blockedAsDuplicate = (
    code: "duplicate" | "duplicate_in_erp",
    message: string,
  ): MatchResult => ({
    invoiceNumber: invoice.invoiceNumber,
    poNumber: purchaseOrder?.poNumber ?? invoice.poNumber ?? null,
    matchType,
    verdict: "duplicate",
    exceptions: [
      {
        sku: "—",
        code,
        message,
        variancePct: 0,
        invoiceValue: invoice.total,
        expectedValue: null,
      },
    ],
    maxVariancePct: 0,
    exceptionAmount: invoice.total,
    currency,
    invoiceTotal: invoice.total,
    department,
  });

  // 1a. In-run duplicate: the same invoice number was already seen earlier in the
  //     queue we're processing (e.g. a vendor re-send). Block before anything else.
  if (priorInvoiceNumbers.includes(invoice.invoiceNumber)) {
    return blockedAsDuplicate(
      "duplicate",
      `Invoice ${invoice.invoiceNumber} has already been processed — blocking to prevent a double payment.`,
    );
  }

  // 1b. Already-paid duplicate: a bill with this vendor + number is ALREADY posted
  //     in the client's ERP (paid in a prior period, outside this run). This is the
  //     historical duplicate the in-run check can't see — caught against the pulled
  //     posted-bill list.
  if (postedBillKeys?.has(billKey(invoice.vendor, invoice.invoiceNumber))) {
    return blockedAsDuplicate(
      "duplicate_in_erp",
      `Invoice ${invoice.invoiceNumber} from ${invoice.vendor} is already posted as a bill in the ERP — blocking a double payment.`,
    );
  }

  const exceptions: MatchException[] = [];

  // Invoice-level: a bill from a vendor the ERP marks inactive is a control signal
  // (a deactivated supplier shouldn't be sending payable invoices). Flagged once
  // for the whole invoice, routed to a human — not blocked outright.
  if (inactiveVendors?.has(invoice.vendor)) {
    exceptions.push({
      sku: "—",
      code: "vendor_inactive",
      message: `Vendor "${invoice.vendor}" is marked inactive in the ERP — invoice needs review before payment.`,
      variancePct: 0,
      invoiceValue: invoice.total,
      expectedValue: null,
    });
  }

  // Index the PO and receipt lines by SKU for line-level comparison.
  const poLines = new Map(
    (purchaseOrder?.lineItems ?? []).map((li) => [li.sku, li] as const),
  );
  const receiptLines = new Map(
    (goodsReceipt?.lineItems ?? []).map((li) => [li.sku, li] as const),
  );

  for (const line of invoice.lineItems) {
    // 2. Internal arithmetic: does the line's own amount equal qty × unitPrice?
    //    Catches transcription/parser errors before we even compare to the PO.
    const computed = round2(line.qty * line.unitPrice);
    if (Math.abs(computed - round2(line.amount)) > tolerances.lineAmountAbs) {
      exceptions.push({
        sku: line.sku,
        code: "unit_price_x_qty",
        message: `Line ${line.sku}: amount ${money(line.amount, currency)} ≠ qty ${line.qty} × ${money(line.unitPrice, currency)} (${money(computed, currency)}).`,
        variancePct: relDiff(line.amount, computed),
        invoiceValue: line.amount,
        expectedValue: computed,
      });
    }

    // 2b. Against the ERP item catalog: an invoiced SKU the client's ERP doesn't
    //     know shouldn't be payable (wrong item, or off-contract). Only checked
    //     when a NON-EMPTY catalog was pulled — an empty set means "unknown / not
    //     pulled", not "every SKU is off-catalog".
    if (catalogSkus && catalogSkus.size > 0 && !catalogSkus.has(line.sku)) {
      exceptions.push({
        sku: line.sku,
        code: "sku_not_in_catalog",
        message: `Line ${line.sku} (${line.description}) isn't in the ERP item catalog.`,
        variancePct: 0,
        invoiceValue: line.amount,
        expectedValue: null,
      });
    }

    // 3. Against the PO: no PO line → can't authorize; else compare price & qty.
    const po = poLines.get(line.sku);
    if (!po) {
      exceptions.push({
        sku: line.sku,
        code: "no_po_line",
        message: `Line ${line.sku} (${line.description}) isn't on PO ${purchaseOrder?.poNumber ?? invoice.poNumber ?? "—"}.`,
        variancePct: 0,
        invoiceValue: line.amount,
        expectedValue: null,
      });
    } else {
      const priceVar = relDiff(line.unitPrice, po.unitPrice);
      if (priceVar > tolerances.pricePct) {
        exceptions.push({
          sku: line.sku,
          code: "price_variance",
          message: `Line ${line.sku}: invoiced at ${money(line.unitPrice, currency)}/unit vs PO ${money(po.unitPrice, currency)}/unit (${pct(priceVar)} over).`,
          variancePct: priceVar,
          invoiceValue: line.unitPrice,
          expectedValue: po.unitPrice,
        });
      }
      if (Math.abs(line.qty - po.qty) > tolerances.qtyAbs) {
        exceptions.push({
          sku: line.sku,
          code: "qty_variance_po",
          message: `Line ${line.sku}: invoiced ${line.qty} units vs PO ${po.qty} ordered.`,
          variancePct: relDiff(line.qty, po.qty),
          invoiceValue: line.qty,
          expectedValue: po.qty,
        });
      }
    }

    // 4. Against the goods receipt (3-way only): never pay for more than was
    //    actually received. A missing receipt line for an invoiced SKU is an
    //    exception; an invoiced qty above the received qty is an overbill.
    if (goodsReceipt) {
      const gr = receiptLines.get(line.sku);
      if (!gr) {
        exceptions.push({
          sku: line.sku,
          code: "no_receipt_line",
          message: `Line ${line.sku} was invoiced but never recorded as received on ${goodsReceipt.grNumber}.`,
          variancePct: 0,
          invoiceValue: line.qty,
          expectedValue: null,
        });
      } else if (line.qty - gr.receivedQty > tolerances.qtyAbs) {
        exceptions.push({
          sku: line.sku,
          code: "qty_variance_receipt",
          message: `Line ${line.sku}: invoiced ${line.qty} units but only ${gr.receivedQty} received.`,
          variancePct: relDiff(line.qty, gr.receivedQty),
          invoiceValue: line.qty,
          expectedValue: gr.receivedQty,
        });
      }
    }
  }

  const maxVariancePct = exceptions.reduce(
    (m, e) => Math.max(m, e.variancePct),
    0,
  );
  // Money at stake = sum of the absolute line-amount deltas on exception lines.
  const exceptionAmount = round2(
    exceptions.reduce((sum, e) => sum + exceptionLineAmount(invoice, e), 0),
  );

  return {
    invoiceNumber: invoice.invoiceNumber,
    poNumber: purchaseOrder?.poNumber ?? invoice.poNumber ?? null,
    matchType,
    verdict: exceptions.length === 0 ? "clean" : "exception",
    exceptions,
    maxVariancePct,
    exceptionAmount,
    currency,
    invoiceTotal: invoice.total,
    department,
  };
};

/** The invoice-side money on the line an exception refers to (for "amount at stake"). */
const exceptionLineAmount = (invoice: Invoice, e: MatchException): number => {
  const line = invoice.lineItems.find((li) => li.sku === e.sku);
  return line ? Math.abs(line.amount) : 0;
};
