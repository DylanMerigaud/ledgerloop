"use client";

import type { PDFPageProxy } from "pdfjs-dist";

import { useEffect, useRef, useState } from "react";

/**
 * Renders the real invoice PDF (the same bytes the vision model reads) to a
 * canvas with pdf.js, the document shown in the right pane's extraction reveal.
 * An actual PDF, not an HTML mock.
 *
 * The canvas fills its parent's width and keeps A4 ratio; size the document by
 * constraining the parent's width. pdf.js is loaded dynamically (client-only) and
 * its worker is resolved through the bundler via `new URL(..., import.meta.url)`,
 * so there's no CDN dependency. Until the page paints we show an A4-ratio skeleton
 * (not a text spinner) so the layout doesn't jump. Failure falls back to a note.
 */

// A4 portrait aspect ratio (height / width), sizes the skeleton to match the
// rendered page so the layout never shifts.
const A4_RATIO = 841.89 / 595.28;

export const PdfDocument = ({ src, dim }: { src: string; dim: boolean }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Cancellation flag for the async load. Read via `isCancelled()` (a function,
    // not the variable) inside the IIFE: TS narrows a bare boolean to `false` after
    // the first check and can't see the cleanup flip it across awaits, a function
    // call isn't narrowed, so each check is honest (not flagged as "always false").
    let wasCancelled = false;
    const isCancelled = () => wasCancelled;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- resetting load status when `src` changes: the effect owns a fresh async PDF load, so the skeleton must show again while the new document renders.
    setReady(false);
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- paired with the setReady reset above: clear any prior error before the new src's load starts.
    setError(false);

    // Keep the loaded page around so a container resize can re-render at the new
    // width (sharp at any size) without re-fetching the PDF.
    let page: PDFPageProxy | null = null;
    let rendering: Promise<unknown> | null = null;

    const loadPage = async (buf: ArrayBuffer) => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).href;
      return pdfjs.getDocument({ data: buf }).promise;
    };

    const renderAtCurrentWidth = async () => {
      if (!page) return; // `canvas` is already narrowed non-null above
      const cssWidth = canvas.parentElement?.clientWidth ?? 360;
      if (cssWidth === 0) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({
        scale: (cssWidth / base.width) * dpr,
      });
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;
    };

    const ro = new ResizeObserver(() => {
      // Serialise renders, pdf.js throws if a render starts while one is live. Each
      // resize queues behind the previous render (awaiting it, errors swallowed) so
      // the ResizeObserver callback never blocks and renders never overlap.
      const previous = rendering ?? Promise.resolve();
      rendering = (async () => {
        try {
          await previous;
        } catch {
          /* a prior render failed, still attempt this one */
        }
        try {
          await renderAtCurrentWidth();
        } catch {
          /* swallow: a resize mid-teardown can throw, harmless */
        }
      })();
    });

    void (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`pdf fetch ${res.status}`);
        const buf = await res.arrayBuffer();
        if (isCancelled()) return;

        const pdf = await loadPage(buf);
        if (isCancelled()) return;
        page = await pdf.getPage(1);
        if (isCancelled()) return;

        await renderAtCurrentWidth();
        if (isCancelled()) return;
        setReady(true);
        if (canvas.parentElement) ro.observe(canvas.parentElement);
      } catch {
        if (!isCancelled()) setError(true);
      }
    })();

    return () => {
      wasCancelled = true;
      ro.disconnect();
    };
  }, [src]);

  return (
    // The wrapper reserves the A4 footprint via aspect-ratio, so the skeleton and
    // the eventual canvas occupy the same box (no layout jump, no overflow).
    <div className="relative w-full" style={{ aspectRatio: `1 / ${A4_RATIO}` }}>
      {!ready && !error && <div className="absolute inset-0 animate-pulse rounded bg-line/30" />}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center rounded bg-canvas text-center text-[12px] text-muted">
          Couldn&apos;t render the PDF preview.
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 block h-full w-full transition-opacity duration-300 ${
          ready ? (dim ? "opacity-80" : "opacity-100") : "opacity-0"
        }`}
      />
    </div>
  );
};
