import { loadInvoiceById } from "@/db/client";
import { renderInvoicePdf } from "@/lib/invoice-pdf";

/**
 * GET /api/pdf/[id] — render the seeded invoice as a PDF on demand.
 *
 * The PDF isn't stored: it's generated deterministically from the seeded invoice
 * row each request (same invoice → same bytes), so there's no extra DB column,
 * no migration, and the document can never drift from the data. The intake
 * extraction reveal (and the queue hover preview) fetch this, render it with
 * pdf.js, and the model reads the same bytes.
 *
 * Only the invoice is loaded (`loadInvoiceById`), not the whole run bundle — the
 * document doesn't need the PO / receipt / ledger. Because the bytes are
 * deterministic and the data is read-only seed data, the response is cacheable,
 * so re-hovering or re-selecting an invoice is served from the browser cache
 * instead of regenerating the PDF.
 *
 * Node runtime — pdf-lib runs in Node, not Edge.
 */

export const runtime = "nodejs";

export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const { id } = await params;

  let invoice: Awaited<ReturnType<typeof loadInvoiceById>>;
  try {
    invoice = await loadInvoiceById(id);
  } catch {
    return new Response("Could not load the invoice.", { status: 500 });
  }
  if (!invoice) {
    return new Response(`No seeded invoice with id "${id}".`, { status: 404 });
  }

  const bytes = await renderInvoicePdf(invoice);
  // Copy into a fresh ArrayBuffer so the body is a plain BodyInit (not a typed
  // array view over a possibly-larger buffer).
  const body = bytes.slice().buffer;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      // Deterministic bytes from read-only seed data → safe to cache. Re-hovering
      // a seen invoice is then instant (served from cache, no regeneration).
      "cache-control": "public, max-age=3600, immutable",
    },
  });
};
