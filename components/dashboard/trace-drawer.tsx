import type React from "react";

import { useEscapeKey } from "@/hooks/use-escape-key";

/** A minimal right-side drawer that slides over the graph with the trace log. Scrim
    closes it, Esc closes it, body scroll is locked while open. */
export const TraceDrawer = ({
  open,
  onClose,
  invoiceLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  invoiceLabel: string | null;
  children: React.ReactNode;
}) => {
  useEscapeKey(open, onClose);
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-30">
      <button
        type="button"
        aria-label="Close trace"
        onClick={onClose}
        className="absolute inset-0 bg-ink/20 backdrop-blur-[1px]"
      />
      <div
        data-testid="trace-drawer"
        className="absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col bg-surface shadow-lift ring-1 ring-inset ring-line"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-ink">Agent execution trace</p>
            {invoiceLabel && (
              <p className="truncate font-mono text-[11px] text-faint">{invoiceLabel}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            data-testid="trace-close"
            onClick={onClose}
            className="grid size-7 place-items-center rounded-full text-faint hover:bg-subtle hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
};
