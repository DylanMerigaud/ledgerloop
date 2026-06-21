"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";

/**
 * Renders the real invoice PDF (the same bytes the vision model reads) to a
 * canvas with pdf.js — the document shown in the right pane's extraction reveal.
 * An actual PDF, not an HTML mock.
 *
 * pdf.js is loaded dynamically (client-only) and its worker is resolved through
 * the bundler via `new URL(..., import.meta.url)`, so there's no CDN dependency.
 * Until the page paints we show an A4-ratio skeleton (not a text spinner) so the
 * layout doesn't jump. Any failure falls back to a short message.
 */

// A4 portrait aspect ratio (height / width) — used to size the skeleton so it
// matches the rendered page and the layout never shifts.
const A4_RATIO = 841.89 / 595.28;

export function PdfDocument({ src, dim }: { src: string; dim: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setReady(false);
    setError(false);

    // Keep the loaded page around so a container resize can re-render at the new
    // width (sharp at any size) without re-fetching the PDF.
    let page: PDFPageProxy | null = null;
    let rendering: Promise<unknown> | null = null;

    async function loadPage(buf: ArrayBuffer) {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs.getDocument({ data: buf }).promise;
    }

    async function renderAtCurrentWidth() {
      if (!page || !canvas) return;
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
    }

    const ro = new ResizeObserver(() => {
      // Serialise renders — pdf.js throws if a render starts while one is live.
      rendering = (rendering ?? Promise.resolve())
        .catch(() => {})
        .then(renderAtCurrentWidth)
        .catch(() => {});
    });

    (async () => {
      try {
        const buf = await fetch(src).then((r) => {
          if (!r.ok) throw new Error(`pdf fetch ${r.status}`);
          return r.arrayBuffer();
        });
        if (cancelled) return;

        const pdf = await loadPage(buf);
        if (cancelled) return;
        page = await pdf.getPage(1);
        if (cancelled) return;

        await renderAtCurrentWidth();
        if (cancelled) return;
        setReady(true);
        if (canvas.parentElement) ro.observe(canvas.parentElement);
      } catch {
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [src]);

  return (
    // The wrapper reserves the A4 footprint via aspect-ratio, so the skeleton and
    // the eventual canvas occupy the same box (no layout jump, no overflow).
    <div className="relative w-full" style={{ aspectRatio: `1 / ${A4_RATIO}` }}>
      {!ready && !error && (
        <div className="absolute inset-0 animate-pulse rounded bg-line/30" />
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center rounded bg-canvas text-center text-[12px] text-muted">
          Couldn&apos;t render the PDF preview.
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 block h-full w-full rounded ring-1 ring-inset ring-line transition-opacity duration-300 ${
          ready ? (dim ? "opacity-80" : "opacity-100") : "opacity-0"
        }`}
      />
    </div>
  );
}
