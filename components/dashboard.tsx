"use client";

import { useEffect, useRef, useState } from "react";

import {
  ExtractionReveal,
  type ExtractionState,
} from "@/components/extraction-reveal";
import { TraceTimeline } from "@/components/trace-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { QueueItem } from "@/db/client";
import { API_ROUTES } from "@/lib/api-routes";
import {
  outcomeDot,
  outcomeLabel,
  outcomeTone,
  type Outcome,
} from "@/lib/display";
import { formatMoney } from "@/lib/format";
import type { Invoice } from "@/lib/schema";
import type { TraceEvent } from "@/lib/trace";
import { usePipelineRun } from "@/lib/use-pipeline-run";

/**
 * The split-view dashboard.
 *   LEFT  — the invoice queue, each row a seeded invoice with a status pill.
 *   RIGHT — the live agent execution trace for the selected invoice.
 *
 * Selecting a row resets the trace; "Run pipeline" streams a fresh run. State is
 * per-visitor and ephemeral — nothing is written back (the run route is
 * stateless), so every visitor starts from the same pristine queue.
 */
/**
 * Pull the intake (extraction) node out of the trace and shape it for the reveal.
 * The intake step carries `{ document }` while reading and `{ extracted, matches }`
 * once done; we render the document twin + scan from that. Returns null until an
 * intake event exists (i.e. before a run starts, or on a resume).
 */
const readIntake = (
  trace: TraceEvent[],
): { document: Invoice; state: ExtractionState } | null => {
  const intake = trace.find((e) => e.stage === "intake" && e.kind === "step");
  if (!intake) return null;
  const data = (intake.data ?? {}) as {
    document?: Invoice;
    extracted?: Invoice;
    matches?: boolean;
  };
  const document = data.extracted ?? data.document;
  if (!document) return null;
  return {
    document,
    state: {
      status: intake.status === "running" ? "running" : "done",
      extracted: data.extracted ?? null,
      matches: data.matches ?? false,
    },
  };
};

/** Solid play triangle for the Run button. */
const PlayIcon = () => {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 fill-current">
      <path d="M3 1.8v8.4a.6.6 0 0 0 .92.5l6.4-4.2a.6.6 0 0 0 0-1L3.92 1.3A.6.6 0 0 0 3 1.8Z" />
    </svg>
  );
};

/** Small spinner shown while a run is in flight. */
const Spinner = () => {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 animate-spin">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
};

export const Dashboard = ({ queue }: { queue: QueueItem[] }) => {
  const [selectedId, setSelectedId] = useState<string | null>(
    queue[0]?.id ?? null,
  );
  const { state, run, decide, reset } = usePipelineRun();

  // Queue scroll affordance: macOS hides overlay scrollbars, so we show an
  // explicit "N more" pill + fade until the list is scrolled to the bottom.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [scroll, setScroll] = useState({ hiddenBelow: 0, atBottom: true });

  // Right pane (trace) scroll. The trace reads top-down like a log and the key
  // info (document, extraction, first steps) is at the top, so we DON'T auto-
  // scroll — the user keeps their place and the "more ↓" affordance signals
  // there's content below to scroll to at their own pace.
  const traceScrollRef = useRef<HTMLDivElement | null>(null);
  const [traceMore, setTraceMore] = useState(false);

  const measureTrace = () => {
    const el = traceScrollRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
    setTraceMore(remaining > 24);
  };

  useEffect(() => {
    const el = traceScrollRef.current;
    if (!el) return;
    // A fresh run resets the scroll to the top (start of the trace); otherwise
    // leave the user's position alone.
    if (state.status === "idle" || state.trace.length <= 1) el.scrollTop = 0;
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
    setTraceMore(state.status !== "idle" && remaining > 24);
  }, [state.trace, state.status]);

  const measureScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
    setScroll({
      hiddenBelow: Math.max(
        0,
        el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
      atBottom: remaining < 8,
    });
  };

  // Measure on mount and when the queue changes (rows have a fixed height, so we
  // can turn the hidden pixels into an approximate row count for the pill).
  useEffect(() => {
    measureScroll();
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ROW_PX = 63; // approx height of one queue row
  const moreCount = scroll.atBottom
    ? 0
    : Math.max(1, Math.round(scroll.hiddenBelow / ROW_PX));

  const selected = queue.find((q) => q.id === selectedId) ?? null;
  // Lock the queue while a run is in flight — switching invoices mid-run would
  // abort the stream and is confusing. (Awaiting a human decision still locks:
  // resolve it with Approve/Reject first.)
  const locked = state.status === "running" || state.status === "awaiting";

  // Hovering a row previews its PDF on the right (idle only). Falls back to the
  // selected row; ignored while locked so a hover can't replace a live run.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const previewId = (!locked && hoveredId) || selectedId;
  // The trace-pane title follows whatever document is shown (hover preview or the
  // selected/running invoice) so the header never contradicts the PDF on screen.
  const previewItem = queue.find((q) => q.id === previewId) ?? selected;

  const select = (id: string) => {
    if (id === selectedId || locked) return;
    setSelectedId(id);
    reset();
  };

  return (
    // Desktop: fill the parent's flex-1 slot (the page is viewport-tall), so the
    // two panes sit side by side and scroll INTERNALLY — no competing page
    // scroll. Mobile: stack at natural height.
    <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(300px,380px)_1fr]">
      {/* LEFT — queue */}
      <Card className="flex max-h-[70vh] flex-col overflow-hidden lg:max-h-none">
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Invoice queue</CardTitle>
          <span className="text-[11px] text-muted tnum">
            {queue.length} invoices
          </span>
        </CardHeader>
        {/* relative wrapper so the fade + "N more" pill can overlay the scroll
        area — on macOS the overlay scrollbar is hidden, so these are the cue
        that the list continues below. Both hide once scrolled to the end. */}
        <div className="relative min-h-0 flex-1">
          <ul
            ref={listRef}
            onScroll={measureScroll}
            className="scrollbar-slim h-full divide-y divide-line overflow-y-auto"
          >
            {queue.map((item) => {
              const isSelected = item.id === selectedId;
              // The pill reflects the live run only for the selected row; others
              // show their seeded scenario hint as a neutral label.
              const outcome: Outcome = isSelected ? state.outcome : "pending";
              // While a run is in flight the queue is locked: the active row stays
              // highlighted, the others dim and stop responding to clicks.
              const dimmed = locked && !isSelected;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`queue-row-${item.id}`}
                    onClick={() => select(item.id)}
                    onMouseEnter={() => setHoveredId(item.id)}
                    onMouseLeave={() =>
                      setHoveredId((h) => (h === item.id ? null : h))
                    }
                    disabled={dimmed}
                    aria-disabled={dimmed}
                    className={`relative flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                      isSelected ? "bg-accent-soft/50" : "hover:bg-subtle/70"
                    } ${dimmed ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    {isSelected && (
                      <span
                        aria-hidden
                        className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-accent"
                      />
                    )}
                    <span
                      aria-hidden
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-surface"
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
                          <Badge tone={outcomeTone(outcome)}>
                            {outcomeLabel(outcome)}
                          </Badge>
                        ) : (
                          item.scenario && (
                            <span className="shrink-0 text-[10px] text-muted/80">
                              {item.scenario}
                            </span>
                          )
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {/* "N more" scroll affordance: a fade + a pill that scrolls the list
          when clicked. Hidden once the list is at the bottom. */}
          {moreCount > 0 && (
            <>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface via-surface/80 to-transparent"
              />
              <button
                type="button"
                onClick={() =>
                  listRef.current?.scrollBy({
                    top: listRef.current.clientHeight * 0.8,
                    behavior: "smooth",
                  })
                }
                className="absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1 rounded-full bg-ink/85 px-3 py-1 text-[11px] font-medium text-white shadow-lift backdrop-blur transition-opacity hover:bg-ink"
              >
                {moreCount} more
                <span aria-hidden>↓</span>
              </button>
            </>
          )}
        </div>
      </Card>

      {/* RIGHT — trace */}
      <Card className="flex flex-col overflow-hidden">
        <CardHeader className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Agent execution trace</CardTitle>
            {previewItem && (
              <p className="mt-0.5 truncate text-[12px] text-faint">
                {previewItem.vendor} ·{" "}
                <span className="font-mono">{previewItem.invoiceNumber}</span>
              </p>
            )}
          </div>
          {state.status === "awaiting" && selected ? (
            // The run paused for a human decision — show the approval gate.
            <div
              className="flex shrink-0 items-center gap-2"
              data-testid="approval-gate"
            >
              <Button
                variant="danger"
                size="sm"
                data-testid="reject-btn"
                onClick={() => decide(selected.id, "reject")}
              >
                Reject
              </Button>
              <Button
                variant="ok"
                size="sm"
                data-testid="approve-btn"
                onClick={() => decide(selected.id, "approve")}
              >
                Approve
              </Button>
            </div>
          ) : (
            // Run lives in the header at all times a row is selected: "Run
            // pipeline" before the first run, "Running…" while in flight, "Run
            // again" after. (Approval is the only state that swaps it for the gate.)
            selected && (
              <Button
                size="sm"
                data-testid="run-btn"
                disabled={state.status === "running"}
                onClick={() => run(selected.id)}
              >
                {state.status === "running" ? (
                  <>
                    <Spinner />
                    Running…
                  </>
                ) : (
                  <>
                    <PlayIcon />
                    {state.status === "idle" ? "Run pipeline" : "Run again"}
                  </>
                )}
              </Button>
            )
          )}
        </CardHeader>
        {/* relative so the bottom fade + "more" affordance can overlay the scroll
        area — the cue that the trace continues below (esp. on macOS where the
        scrollbar is hidden). */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={traceScrollRef}
            onScroll={measureTrace}
            className="scrollbar-slim h-full overflow-y-auto px-5 py-4"
          >
            {/* The document + extraction panel is ALWAYS shown when a row is in
            view (idle preview, or live during a run), so it never unmounts —
            no flash between selecting and running. `intake` is null until the
            run emits its first event; until then it's a static preview. */}
            {previewId && (
              <div className="mb-4">
                <ExtractionReveal
                  pdfSrc={API_ROUTES.pdf(previewId)}
                  // Show the scanning state the instant Run is clicked — even
                  // before the first stream event lands — so the UI feels
                  // immediate. The real intake event takes over when it arrives.
                  state={
                    readIntake(state.trace)?.state ??
                    (state.status === "running"
                      ? { status: "running", extracted: null, matches: false }
                      : null)
                  }
                  extractedInvoice={readIntake(state.trace)?.document ?? null}
                />
              </div>
            )}
            {state.status !== "idle" && (
              <TraceTimeline
                state={state}
                invoiceLabel={selected?.invoiceNumber ?? null}
                canRun={!!selected}
                onRun={() => selected && run(selected.id)}
              />
            )}
          </div>
          {/* "more ↓" is a trace affordance — only meaningful once a run is
          underway, never on the static PDF preview. */}
          {traceMore && state.status !== "idle" && (
            <>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-xl bg-gradient-to-t from-surface via-surface/80 to-transparent"
              />
              <button
                type="button"
                aria-label="Scroll down"
                onClick={() =>
                  traceScrollRef.current?.scrollBy({
                    top: traceScrollRef.current.clientHeight * 0.8,
                    behavior: "smooth",
                  })
                }
                className="absolute inset-x-0 bottom-2 mx-auto flex w-fit items-center gap-1 rounded-full bg-ink/85 px-3 py-1 text-[11px] font-medium text-white shadow-lift backdrop-blur transition-opacity hover:bg-ink"
              >
                more
                <span aria-hidden>↓</span>
              </button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
};
