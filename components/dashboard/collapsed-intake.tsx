import { useState } from "react";

import type { Invoice } from "@/lib/schema";

import { ExtractionReveal, type ExtractionState } from "@/components/extraction-reveal";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";

/**
 * Once the document has been READ and the run moves on, the big extraction reveal
 * (its moment is over) collapses into this one-line node at the top of the trace,
 * "Intake · INV-2042 · 3 lines · $730 · reconciled with PO", expandable to re-show
 * the document + extracted fields. Keeps the AI-reads-the-doc proof one click away
 * while handing the pane to the workflow (the hero).
 */
export const CollapsedIntake = ({
  pdfSrc,
  document,
  state,
}: {
  pdfSrc: string;
  document: Invoice;
  state: ExtractionState;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 rounded-lg ring-1 ring-inset ring-line">
      <button
        type="button"
        data-testid="intake-collapsed"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-subtle/50"
      >
        <span aria-hidden className="text-ok">
          ✓
        </span>
        <span className="font-medium text-ink">Intake</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {document.vendor} · {document.lineItems.length} lines ·{" "}
          {formatMoney(document.total, document.currency)}
        </span>
        {state.matches && <Badge tone="ok">reconciled with PO</Badge>}
        <span aria-hidden className={`text-faint transition-transform ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          <ExtractionReveal pdfSrc={pdfSrc} state={state} extractedInvoice={document} />
        </div>
      )}
    </div>
  );
};
