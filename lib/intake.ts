import { extractInvoice, type ExtractionResult } from "@/lib/extract";
import { renderInvoicePdfBase64 } from "@/lib/invoice-pdf";
import type { Invoice } from "@/lib/schema";

/**
 * The intake core — render the source document to a PDF, read it back with the
 * vision model, and return the structured invoice the pipeline will run on.
 *
 * This is what makes the extraction REAL: the downstream matching runs on what
 * the model extracted, not on the seeded record. Like production — the document
 * is the source of truth; if the read fails, you don't invent data, the run
 * can't proceed (the caller surfaces an error). The seeded record is only the
 * thing we render the PDF from (our stand-in for "a vendor PDF arrived").
 *
 * The extractor is injectable so tests can run the whole pipeline offline with a
 * mock instead of a live vision call.
 */

/** Render `source` to a PDF and extract it; same tagged result as `extractInvoice`. */
export type Extractor = (pdfBase64: string) => Promise<ExtractionResult>;

type IntakeOk = {
  ok: true;
  /** The invoice the pipeline runs on (the model's output). */
  invoice: Invoice;
  /** True when the extracted header reconciles with the source record. */
  matchesRecord: boolean;
};
type IntakeFail = {
  ok: false;
  reason: string;
};
export type IntakeResult = IntakeOk | IntakeFail;

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Read `source` (the seeded record we render to a PDF) into a structured invoice.
 * Returns the extracted invoice on success, or a failure the caller turns into an
 * error trace event. `extract` + `render` are injectable for offline tests.
 */
export const runIntake = async (
  source: Invoice,
  opts: {
    extract?: Extractor;
    render?: (inv: Invoice) => Promise<string>;
    timeoutMs?: number;
  } = {},
): Promise<IntakeResult> => {
  const extract = opts.extract ?? extractInvoice;
  const render = opts.render ?? renderInvoicePdfBase64;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: ExtractionResult;
  try {
    const pdfBase64 = await render(source);
    result = await Promise.race([
      extract(pdfBase64),
      new Promise<ExtractionResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              kind: "api_error",
              message: "extraction timed out",
            }),
          timeoutMs,
        ),
      ),
    ]);
  } catch {
    return { ok: false, reason: "Could not read the document." };
  }

  if (!result.ok) {
    return {
      ok: false,
      reason:
        result.kind === "validation"
          ? "Extracted data failed validation."
          : result.kind === "refusal"
            ? "The model declined to read the document."
            : result.kind === "no_json"
              ? "The model returned no structured data."
              : "Could not read the document.",
    };
  }

  // Did the extracted header reconcile with the source record on the key fields?
  // (A clean signal for the reveal; the line-level match is the matching step.)
  const matchesRecord =
    result.invoice.invoiceNumber === source.invoiceNumber &&
    (result.invoice.poNumber ?? null) === (source.poNumber ?? null) &&
    Math.abs(result.invoice.total - source.total) < 0.01;

  return { ok: true, invoice: result.invoice, matchesRecord };
};
