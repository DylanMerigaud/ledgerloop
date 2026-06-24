import Anthropic, { APIError } from "@anthropic-ai/sdk";
import {
  Invoice,
  INVOICE_JSON_SCHEMA,
  type Invoice as TInvoice,
} from "./schema";

/**
 * Document extraction — the intake step's real work: a vendor's invoice PDF in,
 * a schema-validated structured `Invoice` out. This is where the AI reads the
 * messy real-world document so the rest of the pipeline can be deterministic.
 *
 * Same discipline as the sibling ai-invoice-parser repo, transposed onto this
 * repo's `Invoice` schema: hand the model `INVOICE_JSON_SCHEMA` (derived from the
 * Zod object, single source of truth), then `Invoice.safeParse` the result. The
 * model reads the PDF directly (vision); nothing is guessed off filenames.
 *
 * Result is a tagged union so callers map each failure to a state instead of a
 * thrown error. The extracted invoice is what the pipeline then runs on (see
 * `lib/intake.ts`); a failure stops the run rather than fabricating data.
 */

/** Sonnet reads the PDF directly via vision; extraction is transcription, not reasoning. */
const EXTRACTION_MODEL = "claude-sonnet-4-6";

export type ExtractionResult =
  | { ok: true; invoice: TInvoice }
  | { ok: false; kind: "validation"; issues: string[] }
  | { ok: false; kind: "no_json" }
  | { ok: false; kind: "refusal" }
  | { ok: false; kind: "api_error"; status?: number; message: string };

const SYSTEM_PROMPT = `You are an invoice data-extraction engine for an accounts-payable system. You are given a single invoice as a PDF and must extract its fields into a strict JSON object matching the provided schema.

Rules:
- Return ONLY data actually present on the document. Never invent or guess values.
- Dates must be ISO-8601 (YYYY-MM-DD). Convert any format you see.
- "currency" is the 3-letter ISO-4217 code (USD, EUR, GBP, ...). Infer from a symbol or explicit code.
- Numbers are plain JSON numbers — no currency symbols, no thousands separators, a period as decimal.
- "lineItems" is one entry per billed line; "amount" is that line's total.
- "subtotal" is the pre-tax sum; "total" is the final amount due. Transcribe the numbers as printed, even if they don't add up — a downstream checker flags inconsistencies. Do NOT silently fix the math.
- Each line item needs a "sku": copy the printed item/SKU code for that line EXACTLY as shown (e.g. the "Item" column). Only if no code is printed, fall back to a short slug of the description.`;

class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "MissingApiKeyError";
  }
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new MissingApiKeyError();
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

/** Extract a base64-encoded PDF into a validated Invoice (or a tagged failure). */
export async function extractInvoice(
  pdfBase64: string,
): Promise<ExtractionResult> {
  let message: Anthropic.Message;
  try {
    message = await getClient().messages.create({
      model: EXTRACTION_MODEL,
      // Headroom for invoices with many line items — a truncated response would
      // be invalid JSON (caught below, but better to not truncate in the first place).
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: INVOICE_JSON_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
            },
            {
              type: "text",
              text: "Extract this invoice into the required JSON object. Return only the JSON.",
            },
          ],
        },
      ],
    });
  } catch (err) {
    return mapApiError(err);
  }

  if (message.stop_reason === "refusal") return { ok: false, kind: "refusal" };

  const raw = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const json = extractJsonObject(raw);
  if (json === undefined) return { ok: false, kind: "no_json" };

  const parsed = Invoice.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      kind: "validation",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  return {
    ok: true,
    invoice: { ...parsed.data, currency: parsed.data.currency.toUpperCase() },
  };
}

/**
 * Pull a JSON object out of the model's text. With structured outputs the whole
 * response should already be valid JSON, but stay defensive: strip code fences
 * and, as a last resort, slice from the first "{" to the last "}".
 */
function extractJsonObject(text: string): unknown {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1]);
    if (inner !== undefined) return inner;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced !== undefined) return sliced;
  }
  return undefined;
}

function mapApiError(err: unknown): ExtractionResult {
  if (err instanceof MissingApiKeyError) {
    return {
      ok: false,
      kind: "api_error",
      message: "Server is missing ANTHROPIC_API_KEY.",
    };
  }
  if (err instanceof APIError) {
    return {
      ok: false,
      kind: "api_error",
      status: err.status,
      message:
        err.status === 429
          ? "Extraction model rate-limited — try again shortly."
          : "The extraction model returned an error.",
    };
  }
  return {
    ok: false,
    kind: "api_error",
    message: "Unexpected error contacting the extraction model.",
  };
}
