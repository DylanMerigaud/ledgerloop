/**
 * Display formatters — pure, unit-tested, shared by the trace UI and the queue.
 * Keeping these here (not inline in components) means the numbers render
 * identically everywhere and the formatting is covered by `pnpm test`.
 */
const round2 = (n: number): number => {
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/** Money with a 3-letter currency suffix and tabular-friendly 2dp. */
export const formatMoney = (amount: number, currency: string): string => {
  const v = round2(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v} ${currency}`;
};

/** A fraction (0.073) as a signed-free percentage string ("7.3%"). */
export const formatPct = (fraction: number): string => {
  return `${(fraction * 100).toFixed(1)}%`;
};

/** Elapsed milliseconds as a compact human string ("820ms", "3.4s"). */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/** Domain acronyms that should stay upper-cased after title-casing. */
const ACRONYMS = new Set(["po", "erp", "sku", "gl", "ap", "id"]);

/** Title-case a snake/kebab token ("qty_variance_po" → "Qty Variance PO"),
 *  keeping known domain acronyms (PO, ERP, SKU, …) upper-cased. */
export const humanize = (token: string): string => {
  return token
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) =>
      ACRONYMS.has(w.toLowerCase())
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
};
