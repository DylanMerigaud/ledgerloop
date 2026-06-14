"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TraceTimeline } from "@/components/trace-timeline";
import { usePipelineRun } from "@/lib/use-pipeline-run";
import { formatMoney } from "@/lib/format";
import { outcomeDot, outcomeLabel, outcomeTone, type Outcome } from "@/lib/display";
import type { QueueItem } from "@/db/client";

/**
 * The split-view dashboard.
 *   LEFT  — the invoice queue, each row a seeded invoice with a status pill.
 *   RIGHT — the live agent execution trace for the selected invoice.
 *
 * Selecting a row resets the trace; "Run pipeline" streams a fresh run. State is
 * per-visitor and ephemeral — nothing is written back (the run route is
 * stateless), so every visitor starts from the same pristine queue.
 */

export function Dashboard({ queue }: { queue: QueueItem[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(queue[0]?.id ?? null);
  const { state, run, decide, reset } = usePipelineRun();

  const selected = queue.find((q) => q.id === selectedId) ?? null;

  function select(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    reset();
  }

  return (
    <div className="grid h-full grid-cols-1 gap-4 lg:min-h-[520px] lg:grid-cols-[minmax(320px,420px)_1fr]">
      {/* LEFT — queue */}
      <Card className="flex max-h-[80vh] flex-col overflow-hidden lg:max-h-none">
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Invoice queue</CardTitle>
          <span className="text-[11px] text-muted tnum">{queue.length} invoices</span>
        </CardHeader>
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {queue.map((item) => {
            const isSelected = item.id === selectedId;
            // The pill reflects the live run only for the selected row; others
            // show their seeded scenario hint as a neutral label.
            const outcome: Outcome = isSelected ? state.outcome : "pending";
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`queue-row-${item.id}`}
                  onClick={() => select(item.id)}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                    isSelected ? "bg-accent-soft/60" : "hover:bg-canvas"
                  }`}
                >
                  <span
                    aria-hidden
                    className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: outcomeDot(outcome) }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">
                        {item.vendor}
                      </span>
                      <span className="shrink-0 text-[12px] tabular-nums text-ink">
                        {formatMoney(item.total, item.currency)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-muted">
                        {item.invoiceNumber}
                        {item.poNumber ? ` · ${item.poNumber}` : ""}
                      </span>
                      {/* Once a run is active for the selected row, show its live
                          outcome badge; otherwise always show the seeded scenario
                          hint (so selecting a row never blanks the label). */}
                      {isSelected && state.status !== "idle" ? (
                        <Badge tone={outcomeTone(outcome)}>{outcomeLabel(outcome)}</Badge>
                      ) : (
                        item.scenario && (
                          <span className="shrink-0 text-[10px] text-muted/80">{item.scenario}</span>
                        )
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* RIGHT — trace */}
      <Card className="flex flex-col overflow-hidden">
        <CardHeader className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Agent execution trace</CardTitle>
            {selected && (
              <p className="mt-0.5 truncate text-[12px] text-muted">
                {selected.vendor} · <span className="font-mono">{selected.invoiceNumber}</span>
              </p>
            )}
          </div>
          {state.status === "awaiting" && selected ? (
            // The run paused for a human decision — show the approval gate.
            <div className="flex shrink-0 items-center gap-2" data-testid="approval-gate">
              <button
                type="button"
                data-testid="reject-btn"
                onClick={() => decide(selected.id, "reject")}
                className="rounded-lg px-3 py-2 text-[13px] font-medium text-danger ring-1 ring-inset ring-danger-line transition-colors hover:bg-danger-soft"
              >
                Reject
              </button>
              <button
                type="button"
                data-testid="approve-btn"
                onClick={() => decide(selected.id, "approve")}
                className="rounded-lg bg-ok px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition-opacity hover:opacity-90"
              >
                Approve
              </button>
            </div>
          ) : (
            // Idle uses the big centered CTA in the empty state below, so the
            // header button only appears once a run is active or finished.
            state.status !== "idle" && (
              <button
                type="button"
                data-testid="run-btn"
                disabled={!selected || state.status === "running"}
                onClick={() => selected && run(selected.id)}
                className="shrink-0 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {state.status === "running" ? "Running…" : "Run again"}
              </button>
            )
          )}
        </CardHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <TraceTimeline
            state={state}
            invoiceLabel={selected?.invoiceNumber ?? null}
            canRun={!!selected}
            onRun={() => selected && run(selected.id)}
          />
        </div>
      </Card>
    </div>
  );
}
