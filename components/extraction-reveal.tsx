"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";
import { PdfDocument } from "@/components/pdf-document";
import type { Invoice } from "@/lib/schema";

/**
 * The intake "extraction reveal" — the visible proof that the AI reads the real
 * document. Left: the actual invoice PDF (the same bytes the vision model reads),
 * rendered with pdf.js and swept by a scan band while reading. Right: the
 * structured fields the model pulled out, revealed one by one.
 *
 * Two states, driven by the intake trace node:
 *   • running  — scanning: the sweep animates, fields are still "reading…"
 *   • done     — the extracted fields are shown; matching ones are checked.
 *
 * The downstream pipeline runs on the trusted seeded record, so a model misread
 * degrades this reveal, never the verdicts.
 */

export interface ExtractionState {
  status: "running" | "done";
  /** The invoice the model extracted (present once done). */
  extracted: Invoice | null;
  /** Did the extracted key fields reconcile with the seeded record? */
  matches: boolean;
}

/** The fields we reveal on the right, in order. */
const FIELD_DELAY_MS = 140;

export function ExtractionReveal({
  pdfSrc,
  state,
  extractedInvoice,
}: {
  /** URL of the real invoice PDF (the bytes the model reads), e.g. /api/pdf/INV-2042. */
  pdfSrc: string;
  /** null = static preview (no run yet); else the live extraction state. */
  state: ExtractionState | null;
  /** The invoice the run carries (for the fields panel). Null in preview. */
  extractedInvoice: Invoice | null;
}) {
  // Three modes: preview (no run), running (scanning), done (fields shown).
  const mode: "preview" | "running" | "done" =
    state == null ? "preview" : state.status === "running" ? "running" : "done";
  const done = mode === "done";

  // Reveal fields one by one once extraction is done (sequential pop-in).
  const fields = extractedInvoice ? buildFields(extractedInvoice) : [];
  // The rows to render — always the full label set, so the panel keeps its shape
  // from preview through done; values fill in from `fields` as they arrive.
  const rows = FIELD_LABELS;
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (!done) {
      setRevealed(0);
      return;
    }
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setRevealed(i);
      if (i >= fields.length) clearInterval(t);
    }, FIELD_DELAY_MS);
    return () => clearInterval(t);
  }, [done, fields.length]);

  // Preview = the PDF on its own, full width. Once a run starts it shares the row
  // with the Extracted panel. (A small reflow at Run is fine; a preview that looks
  // like it's mid-extraction is not.)
  const running = mode === "running";
  return (
    <div
      data-testid="extraction-reveal"
      data-status={mode}
      className={
        mode === "preview"
          ? "mx-auto max-w-[440px]"
          : "grid grid-cols-1 gap-3 sm:grid-cols-[1.1fr_1fr]"
      }
    >
      {/* The real PDF the model reads */}
      <div className="relative overflow-hidden rounded-lg bg-white shadow-card ring-1 ring-inset ring-line">
        {/* scan sweep only while the model is actually reading */}
        {running && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 animate-scan bg-gradient-to-b from-accent/0 via-accent/25 to-accent/0"
          />
        )}
        <PdfDocument src={pdfSrc} dim={running} />
      </div>

      {/* Extracted structure — only once a run is underway (absent in preview, so
          the preview is just the document, not a mid-extraction-looking state). */}
      {mode !== "preview" && (
        <div className="rounded-lg bg-surface p-3 shadow-card ring-1 ring-inset ring-line">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Extracted
            </span>
            {done && state?.matches != null && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  state.matches
                    ? "bg-ok-soft text-ok ring-1 ring-inset ring-ok-line"
                    : "bg-warn-soft text-warn ring-1 ring-inset ring-warn-line"
                }`}
              >
                {state.matches
                  ? "reconciled with PO record"
                  : "differs from record"}
              </span>
            )}
          </div>
          <dl className="space-y-1.5">
            {rows.map((label, i) => (
              <FieldRow
                key={label}
                label={label}
                value={fields[i]?.value ?? ""}
                state={!done ? "reading" : i < revealed ? "shown" : "pending"}
              />
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/** The field labels shown in the Extracted panel, in order (stable across modes). */
const FIELD_LABELS = [
  "Vendor",
  "Invoice no.",
  "PO number",
  "Issue date",
  "Line items",
  "Total",
];

function FieldRow({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: "reading" | "pending" | "shown";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-muted">{label}</span>
      {state === "shown" ? (
        <span className="animate-trace-in truncate text-right font-medium text-ink">
          {value}
        </span>
      ) : (
        <span
          aria-hidden
          className={`h-3 w-24 rounded ${
            state === "reading" ? "animate-pulse bg-line" : "bg-line/40"
          }`}
        />
      )}
    </div>
  );
}

/** Field values aligned positionally with FIELD_LABELS. */
function buildFields(inv: Invoice): { value: string }[] {
  return [
    { value: inv.vendor },
    { value: inv.invoiceNumber },
    { value: inv.poNumber ?? "—" },
    { value: inv.issueDate },
    { value: String(inv.lineItems.length) },
    { value: formatMoney(inv.total, inv.currency) },
  ];
}
