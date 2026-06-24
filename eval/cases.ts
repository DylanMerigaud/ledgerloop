import type { Investigation } from "@/lib/schema";

/**
 * The eval corpus for the EXCEPTION INVESTIGATOR.
 *
 * Each case is a seeded exception invoice (by its row id in `db/seed-data.ts`)
 * paired with the recommendation a human would defend after reading the same
 * vendor records the agent gets ([`lib/vendor-context.ts`](../lib/vendor-context.ts)).
 * The eval runs the REAL agent over each and scores its recommendation against
 * this ground truth — so it measures the agent's judgment, not just that the
 * deterministic routing fires.
 *
 * Ground truth is deliberately mixed (legitimate / overcharge / unclear) so a
 * model that rubber-stamps one answer scores badly. Each `expected` is justified
 * by what's actually in the vendor records, with a note on why.
 */

/** A scoreable recommendation (the investigator's three possible verdicts). */
type Expected = Investigation["recommendation"];

export type EvalCase = {
  /** Row id in db/seed-data.ts. */
  id: string;
  /** What this case stresses — printed in the report. */
  stresses: string;
  /** The recommendation a reviewer would defend from the records. */
  expected: Expected;
  /** Why that's the defensible answer (kept honest; not shown to the agent). */
  rationale: string;
};

export const EVAL_CASES: EvalCase[] = [
  {
    id: "INV-2042",
    stresses: "price variance WITH a documented, pre-flagged surcharge",
    expected: "likely_legitimate",
    rationale:
      "The vendor pre-notified a surcharge in March, the PO note tells AP to expect a few % over, and the price is in line with the market — a legitimate increase, not an overcharge.",
  },
  {
    id: "INV-2045",
    stresses: "arithmetic error on a vendor with a billing-slip history",
    expected: "likely_overcharge",
    rationale:
      "Prices were flat for 3 quarters, no surcharge on file, and the vendor has prior transcription slips — the line-total error is a billing mistake to push back on.",
  },
  {
    id: "INV-2046",
    stresses: "line not on the PO, vendor known for unsolicited add-ons",
    expected: "likely_overcharge",
    rationale:
      "The extra line isn't on the authorized PO, the vendor has a history of unsolicited add-ons, and policy says off-PO lines need a change order before payment.",
  },
  {
    id: "INV-2048",
    stresses: "quantity short-received, invoice bills the full amount",
    expected: "likely_overcharge",
    rationale:
      "Only 80 of 100 were received but the invoice bills 100, and the vendor — who normally flags partial shipments — sent no backorder paperwork. Billing for units not received is an overcharge to push back on (request a credit or clarification).",
  },
];
