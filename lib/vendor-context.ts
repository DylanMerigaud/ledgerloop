/**
 * Messy, free-text vendor context — the "imperfect data" an exception
 * investigation has to reason over.
 *
 * When the deterministic matcher flags an exception (e.g. a 9% price overage),
 * the number alone doesn't tell a reviewer whether it's a legitimate price
 * increase or an overcharge to push back on. The answer lives in unstructured
 * records: past invoices, buyer notes scrawled on the PO, what the warehouse
 * actually wrote on the receipt. Real AP data is exactly this messy.
 *
 * These records are deliberately UNSTRUCTURED strings (not typed rows): the
 * investigator agent reads them like a human would and decides what they mean.
 * That's the point of using an agent here — there's no clean field to compare,
 * so the trajectory (which records to pull, how to weigh them) isn't knowable in
 * advance. The agent's job is judgment over prose; the numbers stay deterministic.
 *
 * Keyed by vendor name (matching the seeded invoices/POs).
 */

type VendorContext = {
  /** Free-text price history / account notes a buyer might keep on a vendor. */
  priceHistory: string;
  /** Buyer-side notes attached to the purchase order (intent, side agreements). */
  poNotes: string;
  /** Warehouse / receiving notes — often where the real story of a delivery is. */
  receiptNotes: string;
};

const VENDOR_CONTEXT: Record<string, VendorContext> = {
  "Severn Steelworks": {
    priceHistory: `Account: Severn Steelworks (steel, GBP). Notes from buyer (R. Okafor):
- Jan: STL-BAR-20 quoted 7.50/m on PO-7742, locked for Q1.
- Mar 3 email from their sales (Dave): "scrap & energy surcharge incoming, ~8-10% on long products from April, will reflect on new POs." We did NOT issue a new PO — kept buying against PO-7742.
- Apr/May: market steel index up sharply (their competitor Brython quoted 8.05/m last month for the same bar). 8.18 is roughly in line with where the market moved.
- No contract clause forcing them to hold Q1 price past the PO quantity; PO-7742 didn't cap the unit price for re-orders.`,
    poNotes: `PO-7742 (Severn Steelworks): raised by R. Okafor. Free-text note on the PO:
"Q1 framework price. Surcharge flagged by vendor for April — finance aware. If invoice comes in a few % over on the bar, that's the surcharge, not an error. Don't bounce it automatically, but anything >12% query it."`,
    receiptNotes: `GR-5542: received in full, 800m bar + 120 sheet, QC passed. Receiver note: "delivery slip had a price addendum stapled — surcharge mentioned. Forwarded to AP."`,
  },

  "Pinpoint Print Supplies": {
    priceHistory: `Account: Pinpoint Print Supplies (consumables, USD). Buyer notes:
- Unit prices have been flat at 64.00 for INK-CYAN/INK-MAG for 3 quarters. No surcharge, no price-increase notice on file.
- Their invoices occasionally have transcription slips (their billing system rounds oddly) — we've caught line-total errors before. This looks like one: the qty and unit price are fine, the line AMOUNT is what's off.`,
    poNotes: `PO-7745 (Pinpoint): standard consumables re-order. Note: "prices firm, no surcharges agreed. Any variance is almost certainly a billing typo on their end — ask for a corrected invoice."`,
    receiptNotes: `GR-5545: received 10 cyan + 10 magenta, all good. No pricing remarks.`,
  },

  "Conduit Cable Co": {
    priceHistory: `Account: Conduit Cable Co (cabling, USD). Buyer notes:
- Reliable vendor, ~2 years. No pricing disputes on file.
- Deliveries are usually complete; partial shipments are rare and they normally flag a backorder when one happens.`,
    poNotes: `PO-7748 (Conduit Cable Co): standard cabling order, full quantity expected in one delivery. No partial-shipment or backorder arrangement noted.`,
    receiptNotes: `GR-5548: received 80 of 100 units of CAT6-305. Receiver note: "20 short on this drop — no backorder paperwork included, unclear if the rest is coming. Flagged to buyer." Invoice bills the full 100.`,
  },

  "Vertex IT Hardware": {
    priceHistory: `Account: Vertex IT Hardware (IT hardware, USD). Buyer notes:
- Occasional account; a few prior invoices included items we hadn't ordered (bundled accessories, "recommended" add-ons).
- We don't pay for lines that aren't on the PO without a change order.`,
    poNotes: `PO-7746 (Vertex IT Hardware): note: "PO is the authorized list. Any line not on it needs a change order before payment — do not auto-approve off-PO lines."`,
    receiptNotes: `GR-5546: received the PO'd items plus one extra SKU not on the order. Receiver note: "extra item arrived unsolicited — not requested on PO-7746."`,
  },
};

/** A short fallback for vendors with no special context on file. */
const defaultContext = (vendor: string): VendorContext => {
  return {
    priceHistory: `Account: ${vendor}. No price-history notes on file. No surcharge notices and no prior billing disputes recorded.`,
    poNotes: `No buyer notes attached to this vendor's purchase orders.`,
    receiptNotes: `No special receiving notes on file for this vendor.`,
  };
};

export const vendorPriceHistory = (vendor: string): string => {
  return (VENDOR_CONTEXT[vendor] ?? defaultContext(vendor)).priceHistory;
};

export const vendorPoNotes = (vendor: string): string => {
  return (VENDOR_CONTEXT[vendor] ?? defaultContext(vendor)).poNotes;
};

export const vendorReceiptNotes = (vendor: string): string => {
  return (VENDOR_CONTEXT[vendor] ?? defaultContext(vendor)).receiptNotes;
};
