import type {
  Invoice,
  PurchaseOrder,
  GoodsReceipt,
  MatchResult,
  MatchException,
} from "./schema";

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

/** Tolerances below which a variance is treated as rounding noise, not a real exception. */
const MATCH_TOLERANCE = {
  /** Relative price tolerance (1% — absorbs FX/rounding without hiding real overcharges). */
  pricePct: 0.01,
  /** Absolute per-line money tolerance for the amount = qty × price arithmetic check. */
  lineAmountAbs: 0.01,
  /** Quantity tolerance (exact — you either received the units or you didn't). */
  qtyAbs: 0,
} as const;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Relative difference |a − b| / max(|b|, ε), guarding divide-by-zero. */
function relDiff(actual: number, expected: number): number {
  const denom = Math.max(Math.abs(expected), 1e-9);
  return Math.abs(actual - expected) / denom;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function money(n: number, currency: string): string {
  const v = round2(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
}

export interface MatchInput {
  invoice: Invoice;
  purchaseOrder: PurchaseOrder | null;
  goodsReceipt: GoodsReceipt | null;
  /**
   * Invoice numbers already seen in this vendor's ledger. If the invoice under
   * test is in here, it's a duplicate (block it — never pay an invoice twice).
   * The pipeline passes the seeded ledger; the check stays pure and testable.
   */
  priorInvoiceNumbers?: readonly string[];
}

/**
 * Run the match. Returns a fully-populated `MatchResult` whose `verdict` drives
 * the workflow's conditional routing:
 *   - "duplicate" → blocked (no payment)
 *   - "exception" → routed to Approval
 *   - "clean"     → straight-through to Reconciliation
 */
export function runMatch(input: MatchInput): MatchResult {
  const {
    invoice,
    purchaseOrder,
    goodsReceipt,
    priorInvoiceNumbers = [],
  } = input;
  const currency = invoice.currency;
  const matchType: MatchResult["matchType"] = goodsReceipt
    ? "three_way"
    : "two_way";

  // 1. Duplicate detection short-circuits everything else: a duplicate invoice
  //    is a control failure, not a pricing question. Block before we reason
  //    about line variances at all.
  const isDuplicate = priorInvoiceNumbers.includes(invoice.invoiceNumber);
  if (isDuplicate) {
    return {
      invoiceNumber: invoice.invoiceNumber,
      poNumber: purchaseOrder?.poNumber ?? invoice.poNumber ?? null,
      matchType,
      verdict: "duplicate",
      exceptions: [
        {
          sku: "—",
          code: "duplicate",
          message: `Invoice ${invoice.invoiceNumber} has already been processed — blocking to prevent a double payment.`,
          variancePct: 0,
          invoiceValue: invoice.total,
          expectedValue: null,
        },
      ],
      maxVariancePct: 0,
      exceptionAmount: invoice.total,
      currency,
      invoiceTotal: invoice.total,
    };
  }

  const exceptions: MatchException[] = [];

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
    if (
      Math.abs(computed - round2(line.amount)) > MATCH_TOLERANCE.lineAmountAbs
    ) {
      exceptions.push({
        sku: line.sku,
        code: "unit_price_x_qty",
        message: `Line ${line.sku}: amount ${money(line.amount, currency)} ≠ qty ${line.qty} × ${money(line.unitPrice, currency)} (${money(computed, currency)}).`,
        variancePct: relDiff(line.amount, computed),
        invoiceValue: line.amount,
        expectedValue: computed,
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
      if (priceVar > MATCH_TOLERANCE.pricePct) {
        exceptions.push({
          sku: line.sku,
          code: "price_variance",
          message: `Line ${line.sku}: invoiced at ${money(line.unitPrice, currency)}/unit vs PO ${money(po.unitPrice, currency)}/unit (${pct(priceVar)} over).`,
          variancePct: priceVar,
          invoiceValue: line.unitPrice,
          expectedValue: po.unitPrice,
        });
      }
      if (Math.abs(line.qty - po.qty) > MATCH_TOLERANCE.qtyAbs) {
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
      } else if (line.qty - gr.receivedQty > MATCH_TOLERANCE.qtyAbs) {
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
  };
}

/** The invoice-side money on the line an exception refers to (for "amount at stake"). */
function exceptionLineAmount(invoice: Invoice, e: MatchException): number {
  const line = invoice.lineItems.find((li) => li.sku === e.sku);
  return line ? Math.abs(line.amount) : 0;
}
