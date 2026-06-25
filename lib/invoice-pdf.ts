import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

import type { Invoice } from "@/lib/schema";

/**
 * Render an `Invoice` to a realistic one-page PDF (pdf-lib). Generated on demand
 * from the seeded invoice (see `app/api/pdf/[id]`) so the intake step has a real
 * document to read — the "AI reads the messy document" half of the demo — with no
 * stored binary and no chance of the PDF drifting from the data.
 *
 * It draws the data AS GIVEN (defects included): if a seeded line's amount is a
 * deliberate arithmetic error, the PDF shows that error, because that's what a
 * real vendor would have sent. The text is real text (not a scanned image), so a
 * vision model reads it cleanly.
 */

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 56;

const money = (n: number, currency: string): string => {
  return (
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) +
    " " +
    currency
  );
};

/** Returns the invoice as PDF bytes (Uint8Array). */
export const renderInvoicePdf = async (
  invoice: Invoice,
): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.04, 0.04, 0.04);
  const muted = rgb(0.45, 0.45, 0.45);
  const line = rgb(0.85, 0.85, 0.85);

  // y is measured from the TOP here for readability; convert on draw.
  const draw = (
    s: string,
    x: number,
    yTop: number,
    f: PDFFont = font,
    size = 10,
    color = ink,
  ) => page.drawText(s, { x, y: PAGE_H - yTop, font: f, size, color });

  const rightOf = (s: string, f: PDFFont, size: number, xRight: number) =>
    xRight - f.widthOfTextAtSize(s, size);

  // ── Header ────────────────────────────────────────────────────────────────
  draw(invoice.vendor, MARGIN, MARGIN + 6, bold, 18);
  draw(
    "INVOICE",
    rightOf("INVOICE", bold, 18, PAGE_W - MARGIN),
    MARGIN + 6,
    bold,
    18,
    muted,
  );

  // ── Meta block ──────────────────────────────────────────────────────────────
  let y = MARGIN + 56;
  const meta: Array<[string, string]> = [
    ["Invoice No.", invoice.invoiceNumber],
    ["PO Number", invoice.poNumber ?? "—"],
    ["Issue date", invoice.issueDate],
    ["Currency", invoice.currency],
  ];
  for (const [label, value] of meta) {
    draw(label, MARGIN, y, font, 10, muted);
    draw(value, MARGIN + 110, y, font, 10);
    y += 18;
  }

  // ── Line-item table ───────────────────────────────────────────────────────
  // The SKU column is printed because matching joins invoice ↔ PO ↔ receipt by
  // SKU — the extraction has to be able to read the item code off the document
  // (a real invoice carries one), otherwise the downstream match has no key.
  y += 24;
  const colSku = MARGIN;
  const colDesc = MARGIN + 110;
  const colQty = 360;
  const colUnit = 420;
  const colAmt = PAGE_W - MARGIN;
  draw("Item", colSku, y, bold, 9, muted);
  draw("Description", colDesc, y, bold, 9, muted);
  draw("Qty", colQty, y, bold, 9, muted);
  draw("Unit price", colUnit, y, bold, 9, muted);
  draw("Amount", rightOf("Amount", bold, 9, colAmt), y, bold, 9, muted);
  y += 8;
  page.drawLine({
    start: { x: MARGIN, y: PAGE_H - y },
    end: { x: PAGE_W - MARGIN, y: PAGE_H - y },
    thickness: 0.75,
    color: line,
  });
  y += 18;

  for (const li of invoice.lineItems) {
    draw(li.sku, colSku, y, font, 9);
    draw(li.description, colDesc, y, font, 10);
    draw(String(li.qty), colQty, y, font, 10);
    draw(money(li.unitPrice, invoice.currency), colUnit, y, font, 10);
    const amt = money(li.amount, invoice.currency);
    draw(amt, rightOf(amt, font, 10, colAmt), y, font, 10);
    y += 20;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  y += 10;
  page.drawLine({
    start: { x: 330, y: PAGE_H - y },
    end: { x: PAGE_W - MARGIN, y: PAGE_H - y },
    thickness: 0.75,
    color: line,
  });
  y += 20;
  const totalRow = (label: string, value: string, f: PDFFont, size: number) => {
    draw(label, 330, y, f, size, label === "Total due" ? ink : muted);
    draw(value, rightOf(value, f, size, colAmt), y, f, size);
    y += 20;
  };
  totalRow("Subtotal", money(invoice.subtotal, invoice.currency), font, 10);
  if (invoice.tax != null) {
    totalRow("Tax", money(invoice.tax, invoice.currency), font, 10);
  }
  totalRow("Total due", money(invoice.total, invoice.currency), bold, 12);

  return doc.save();
};

/** Render and return base64 — the form the vision model's `document` block wants. */
export const renderInvoicePdfBase64 = async (
  invoice: Invoice,
): Promise<string> => {
  const bytes = await renderInvoicePdf(invoice);
  return Buffer.from(bytes).toString("base64");
};
