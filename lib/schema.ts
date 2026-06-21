import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The Zod schemas in this file are the SINGLE SOURCE OF TRUTH for the whole
 * pipeline, the same discipline as the sibling ai-invoice-parser repo:
 *
 *   1. They can constrain a model at generation time — `INVOICE_JSON_SCHEMA`
 *      (below) is derived from the `Invoice` object for a structured-output model.
 *   2. They validate every model/tool/DB boundary at runtime (`.safeParse`),
 *      so a bad value becomes a handled trace step, never a crash.
 *   3. Their inferred TypeScript types flow into the Drizzle layer, the Mastra
 *      step I/O, the streaming trace, and the React UI — one definition, no
 *      drift between the model, the validator, the database, and the screen.
 *
 * The procure-to-pay state accretes as it moves down the pipeline: each stage's
 * output schema is the next stage's input schema. Read top-to-bottom and you're
 * reading the data model of the whole demo.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 *  Primitives (shared, reused — keep validation identical everywhere)
 * ────────────────────────────────────────────────────────────────────────── */

/** A 3-letter ISO-4217-ish currency code. Shape only — we don't enumerate codes. */
const Currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "currency must be a 3-letter code, e.g. USD, EUR, GBP");

/** ISO-8601 calendar date (YYYY-MM-DD), validated as a real date. */
const IsoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO-8601 (YYYY-MM-DD)")
  .refine(
    (s) => !Number.isNaN(Date.parse(s)),
    "date is not a valid calendar date",
  );

/** A finite monetary / numeric amount. */
const Amount = z
  .number({ invalid_type_error: "expected a number" })
  .finite("must be a finite number");

/** A non-negative quantity. */
const Quantity = Amount.nonnegative("quantity cannot be negative");

/* ────────────────────────────────────────────────────────────────────────── *
 *  Line items — the unit that matching compares across documents
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A single billed line. `sku` is the join key used by the matcher to line up an
 * invoice line against its purchase-order line and goods-receipt line. Real AP
 * systems match on a mix of SKU + description fuzzy-match; we use a clean SKU so
 * the demo's matching is explainable on a sales call.
 */
export const LineItem = z
  .object({
    sku: z.string().trim().min(1, "line item needs a SKU"),
    description: z.string().trim().min(1, "line item needs a description"),
    qty: Quantity.describe("quantity for this line item"),
    unitPrice: Amount.describe("price per unit"),
    amount: Amount.describe("line total (qty x unitPrice)"),
  })
  .strict();
export type LineItem = z.infer<typeof LineItem>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Stage 0 — the documents (seeded, read-only)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The parsed invoice. This is also the shape a document-extraction step would
 * produce from a PDF/text — `INVOICE_JSON_SCHEMA` below is derived from it.
 */
export const Invoice = z
  .object({
    invoiceNumber: z.string().trim().min(1, "invoice number is required"),
    poNumber: z.string().trim().min(1).nullish(),
    vendor: z.string().trim().min(1, "vendor is required"),
    issueDate: IsoDate,
    currency: Currency,
    lineItems: z.array(LineItem).min(1, "at least one line item is required"),
    subtotal: Amount,
    tax: Amount.nullish(),
    total: Amount,
  })
  .strict();
export type Invoice = z.infer<typeof Invoice>;

/** A purchase order — what we agreed to buy and at what price. */
export const PurchaseOrder = z
  .object({
    poNumber: z.string().trim().min(1),
    vendor: z.string().trim().min(1),
    currency: Currency,
    lineItems: z.array(LineItem).min(1),
    total: Amount,
  })
  .strict();
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

/**
 * A goods receipt — what the warehouse actually accepted. Only quantities matter
 * here (you receive units, not prices), so each line is sku + receivedQty. The
 * presence/absence of a goods receipt is what makes a match "3-way" vs "2-way".
 */
export const GoodsReceiptLine = z
  .object({
    sku: z.string().trim().min(1),
    description: z.string().trim().min(1),
    receivedQty: Quantity,
  })
  .strict();
export type GoodsReceiptLine = z.infer<typeof GoodsReceiptLine>;

export const GoodsReceipt = z
  .object({
    grNumber: z.string().trim().min(1),
    poNumber: z.string().trim().min(1),
    receivedDate: IsoDate,
    lineItems: z.array(GoodsReceiptLine).min(1),
  })
  .strict();
export type GoodsReceipt = z.infer<typeof GoodsReceipt>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Stage 2 — matching result (output of the deterministic matcher)
 * ────────────────────────────────────────────────────────────────────────── */

/** Why a given line failed to reconcile (or, for `duplicate`, the whole invoice). */
const MatchExceptionCode = z.enum([
  "price_variance", // invoice unit price differs from the PO unit price
  "qty_variance_po", // invoice qty differs from the PO qty
  "qty_variance_receipt", // invoice qty exceeds what was actually received
  "unit_price_x_qty", // line amount != qty * unitPrice (arithmetic)
  "no_po_line", // invoice line has no matching PO line
  "no_receipt_line", // (3-way only) invoice line was never received
  "duplicate", // this invoice number was already processed (block, don't pay twice)
]);

/** A single reconciliation problem on a single line, with the supporting numbers. */
export const MatchException = z
  .object({
    sku: z.string(),
    code: MatchExceptionCode,
    message: z.string(),
    /** Magnitude of the discrepancy as a fraction (0.07 = 7%). 0 for binary issues. */
    variancePct: z.number().nonnegative(),
    invoiceValue: z.number().nullable(),
    expectedValue: z.number().nullable(),
  })
  .strict();
export type MatchException = z.infer<typeof MatchException>;

/** The overall matching verdict for an invoice. */
const MatchVerdict = z.enum([
  "clean", // everything reconciles within tolerance → eligible for straight-through
  "exception", // one or more lines have variances → needs a decision
  "duplicate", // this invoice number was already seen → block, don't pay twice
]);

export const MatchResult = z
  .object({
    invoiceNumber: z.string(),
    poNumber: z.string().nullable(),
    /** "three_way" when a goods receipt was present, else "two_way". */
    matchType: z.enum(["two_way", "three_way"]),
    verdict: MatchVerdict,
    exceptions: z.array(MatchException),
    /** Largest single-line variance, used by the approval policy for tiering. */
    maxVariancePct: z.number().nonnegative(),
    /** Absolute money at stake across all exception lines, for the approval tier. */
    exceptionAmount: z.number().nonnegative(),
    currency: Currency,
    invoiceTotal: Amount,
  })
  .strict();
export type MatchResult = z.infer<typeof MatchResult>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Stage 2.5 — exception investigation (the one open-ended AGENT step)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The investigator agent's recommendation, produced ONLY on the exception path.
 * It's a recommendation for the human reviewer, never a decision: the agent reads
 * messy vendor records (price history, PO notes, receipt notes) of its own
 * choosing and forms a view on whether the flagged variance looks legitimate.
 *
 *   recommendation — what the agent suggests the reviewer do
 *   rationale      — one or two sentences citing what it found
 *   toolsUsed      — which records it pulled (shows the open-ended trajectory)
 */
export const Investigation = z
  .object({
    invoiceNumber: z.string(),
    recommendation: z.enum([
      "likely_legitimate",
      "likely_overcharge",
      "unclear",
    ]),
    rationale: z.string(),
    toolsUsed: z.array(z.string()),
  })
  .strict();
export type Investigation = z.infer<typeof Investigation>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Stage 3 — approval decision (output of the deterministic policy)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Who must sign off. Tiers escalate with the money/variance at stake. A clean
 * invoice is `auto` (no human); larger exceptions climb to manager / director.
 */
export const ApproverTier = z.enum(["auto", "manager", "director", "blocked"]);
export type ApproverTier = z.infer<typeof ApproverTier>;

export const ApprovalDecision = z
  .object({
    invoiceNumber: z.string(),
    tier: ApproverTier,
    /** True only for `auto` — the straight-through-processing path. */
    autoApproved: z.boolean(),
    reason: z.string(),
    /** Echoed through so reconciliation/UI can show what drove the routing. */
    maxVariancePct: z.number().nonnegative(),
    exceptionAmount: z.number().nonnegative(),
    currency: Currency,
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Stage 4 — reconciliation result (output of the deterministic ERP post)
 * ────────────────────────────────────────────────────────────────────────── */

/** A double-entry GL posting line. Debits and credits must net to zero. */
export const GlEntry = z
  .object({
    account: z.string(),
    debit: Amount.nonnegative(),
    credit: Amount.nonnegative(),
  })
  .strict();
export type GlEntry = z.infer<typeof GlEntry>;

/**
 * How the reconciliation step resolved:
 *   posted    — booked to the ERP (clean auto, or human-approved)
 *   awaiting  — held pending a human approval decision (the run paused here)
 *   rejected  — a reviewer declined it; not posted
 *   blocked   — a duplicate; never posted
 */
const ReconOutcome = z.enum(["posted", "awaiting", "rejected", "blocked"]);

export const ReconResult = z
  .object({
    invoiceNumber: z.string(),
    outcome: ReconOutcome,
    posted: z.boolean(),
    /** Reference returned by the (fake) ERP adapter, e.g. "NETSUITE-BILL-1042". */
    erpRef: z.string().nullable(),
    glEntries: z.array(GlEntry),
    currency: Currency,
    amount: Amount,
    note: z.string(),
  })
  .strict();
export type ReconResult = z.infer<typeof ReconResult>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  JSON Schema derived from the Invoice Zod object
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Built from the SAME `Invoice` Zod object so a structured-output model and the
 * runtime validator can't drift — the single-source-of-truth discipline applied
 * to the model boundary. Emitted inline (no `$ref`/`definitions` wrapper) with
 * `$schema` stripped, the cleanest shape to hand a model.
 *
 * This is the seam for a document-extraction intake (text/PDF → `Invoice`): hand
 * this schema to the model, then `Invoice.safeParse` its output. The seeded demo
 * starts from already-structured records, so nothing calls it at runtime yet —
 * it's kept (and unit-tested) as the ready integration point.
 */
function buildInvoiceJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(Invoice, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

export const INVOICE_JSON_SCHEMA = buildInvoiceJsonSchema();
