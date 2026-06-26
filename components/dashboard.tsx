"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  ExtractionReveal,
  type ExtractionState,
} from "@/components/extraction-reveal";
import { RecentRuns } from "@/components/recent-runs";
import { TraceTimeline } from "@/components/trace-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkflowGraph, type StepStatuses } from "@/components/workflow-graph";
import type { QueueItem } from "@/db/client";
import { useEventCallback } from "@/hooks/use-event-callback";
import { API_ROUTES } from "@/lib/api-routes";
import {
  ApprovalWorkflow,
  type ApprovalWorkflow as TApprovalWorkflow,
} from "@/lib/approval-workflow";
import { isRecord } from "@/lib/assert";
import {
  outcomeDot,
  outcomeLabel,
  outcomeTone,
  type Outcome,
} from "@/lib/display";
import { formatMoney } from "@/lib/format";
import { orpc } from "@/lib/orpc/client";
import { pendingGates } from "@/lib/run-outcome";
import type { Invoice } from "@/lib/schema";
import type { TraceEvent } from "@/lib/trace";
import { usePipelineRun } from "@/lib/use-pipeline-run";

/**
 * The split-view dashboard.
 *   LEFT  — the invoice queue, each row a seeded invoice with a status pill.
 *   RIGHT — the live agent execution trace for the selected invoice.
 *
 * Selecting a row resets the trace; "Run pipeline" streams a fresh run. The live
 * trace state is per-visitor and ephemeral, but each completed run is persisted as
 * an append-only audit row (the Recent runs panel below the queue lists them,
 * replayable). A nightly reset clears those, so every morning starts pristine.
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

/**
 * Pull the approval workflow + each step's live status out of the trace, so the
 * Pipeline can render the SAME graph the onboarding screen draws — lit up by this
 * invoice's path (a gate "In review", "Approved", "Skipped"). The approval node
 * carries `{ workflow, steps: [{id, status}] }`; we validate the workflow off the
 * trace (no cast) and map the step statuses into the shape WorkflowGraph wants.
 * Returns null until the run has produced an approval node (intake/matching first).
 */
const readRunGraph = (
  trace: TraceEvent[],
): { workflow: TApprovalWorkflow; statuses: StepStatuses } | null => {
  const approval = trace.find(
    (e) => e.stage === "approval" && e.kind === "step",
  );
  if (!approval || !isRecord(approval.data)) return null;
  const parsed = ApprovalWorkflow.safeParse(approval.data["workflow"]);
  if (!parsed.success) return null;

  const statuses: StepStatuses = {};
  const steps = approval.data["steps"];
  if (Array.isArray(steps)) {
    for (const s of steps) {
      if (
        isRecord(s) &&
        typeof s["id"] === "string" &&
        typeof s["status"] === "string"
      ) {
        statuses[s["id"]] = s["status"];
      }
    }
  }
  return { workflow: parsed.data, statuses };
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

/**
 * "Running against: <workflow>" — the line that makes the link to onboarding
 * visible: the pipeline routes every invoice through this exact workflow. Shows
 * the active workflow's name once discovery/edits have produced one; otherwise a
 * quiet note that the default DAG is in use until the user derives theirs.
 */
const RunningAgainst = ({
  workflow,
}: {
  workflow: TApprovalWorkflow | null;
}) => {
  if (!workflow) {
    return (
      <p className="mt-1 text-[11px] text-faint">
        Default workflow — run discovery to route against your own.
      </p>
    );
  }
  return (
    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
      <span aria-hidden className="text-faint">
        ↳
      </span>
      Running against{" "}
      <span className="truncate font-medium text-ink">{workflow.name}</span>
    </p>
  );
};

export const Dashboard = ({
  queue,
  workflow,
}: {
  queue: QueueItem[];
  /** The active approval workflow this pipeline runs against (lifted from
      onboarding via AppView). null until discovery has run — the server then falls
      back to its default DAG. */
  workflow: TApprovalWorkflow | null;
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(
    queue[0]?.id ?? null,
  );
  const { state, run, decide, decideMany, reset, replay } =
    usePipelineRun(workflow);
  const queryClient = useQueryClient();

  // When a run reaches a terminal state (done/blocked, not a mid-run pause), a new
  // audit row exists — refresh the Recent runs list so it shows up. Keyed off the
  // status transition so we invalidate once per completion, not on every event.
  const lastStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = lastStatusRef.current;
    lastStatusRef.current = state.status;
    if (prev !== state.status && state.status === "done") {
      void queryClient.invalidateQueries({ queryKey: orpc.history.key() });
    }
  }, [state.status, queryClient]);

  // Replaying a stored run drops its trace into the pane AND selects its invoice,
  // so the header/PDF match what's shown. Ignored while a live run is locked.
  const replayRun = (invoiceNumber: string, trace: TraceEvent[]) => {
    const row = queue.find((q) => q.invoiceNumber === invoiceNumber);
    if (row) setSelectedId(row.id);
    replay(trace);
  };

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

  // The live run graph: once the run reaches approval it carries the workflow +
  // each step's status, so we light up the SAME canvas onboarding draws. Before
  // that (or on a run with no active workflow) we draw the active workflow idle, so
  // the user sees their workflow waiting to route. Null when there's nothing to draw.
  const runGraph = readRunGraph(state.trace);
  const graphToShow = runGraph?.workflow ?? workflow;
  const graphStatuses = runGraph?.statuses;

  // The gates the paused run is waiting on (joined: live status + the workflow's
  // people). Drives the inline per-node Approve/Reject and the submit affordance.
  const gates =
    state.status === "awaiting" && graphStatuses && graphToShow
      ? pendingGates(graphStatuses, graphToShow.steps)
      : [];
  const pendingIds = gates.map((g) => g.id);

  // Decisions staged on the parallel gates, before the reviewer submits the wave.
  // (One gate → the header buttons resume immediately; this is for 2+ at once.)
  const [gateChoices, setGateChoices] = useState<
    Record<string, "approve" | "reject">
  >({});
  // Clear staged decisions whenever the run leaves the awaiting state (resolved,
  // re-run, or a new wave streams in fresh) so they never leak across waves/runs.
  const awaiting = state.status === "awaiting";
  const wasAwaitingRef = useRef(false);
  useEffect(() => {
    if (wasAwaitingRef.current && !awaiting) setGateChoices({});
    wasAwaitingRef.current = awaiting;
  }, [awaiting]);

  const setGate = useEventCallback((id: string, choice: "approve" | "reject") =>
    setGateChoices((m) => ({ ...m, [id]: choice })),
  );
  const setAllGates = (choice: "approve" | "reject") =>
    setGateChoices(Object.fromEntries(pendingIds.map((id) => [id, choice])));
  const allDecided =
    gates.length > 0 && pendingIds.every((id) => gateChoices[id]);

  const select = (id: string) => {
    if (id === selectedId || locked) return;
    setSelectedId(id);
    setGateChoices({});
    reset();
  };

  return (
    // Desktop: fill the parent's flex-1 slot (the page is viewport-tall), so the
    // two panes sit side by side and scroll INTERNALLY — no competing page
    // scroll. Mobile: stack at natural height.
    <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(300px,380px)_1fr]">
      {/* LEFT — queue (fills the column) + the Recent runs audit panel below it. */}
      <div className="flex min-h-0 flex-col gap-4 lg:h-full">
        <Card className="flex max-h-[70vh] flex-col overflow-hidden lg:min-h-0 lg:max-h-none lg:flex-1">
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

        {/* The audit trail: recent runs, each replayable into the trace pane. */}
        <RecentRuns onReplay={replayRun} disabled={locked} />
      </div>

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
            <RunningAgainst workflow={workflow} />
          </div>
          {state.status === "awaiting" && selected && gates.length >= 2 ? (
            // Several gates pend in parallel — decide each on its node in the graph,
            // then submit the wave. Approve/Reject all are shortcuts.
            <div
              className="flex shrink-0 items-center gap-2"
              data-testid="approval-gate-multi"
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAllGates("reject")}
              >
                Reject all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAllGates("approve")}
              >
                Approve all
              </Button>
              <Button
                size="sm"
                data-testid="submit-decisions"
                disabled={!allDecided}
                onClick={() => decideMany(selected.id, gateChoices)}
              >
                Submit decisions
              </Button>
            </div>
          ) : state.status === "awaiting" && selected ? (
            // A single gate — decide it straight from the header.
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
            {/* The live workflow graph — the SAME canvas onboarding draws, lit up
            by this invoice's path (a gate "In review" / "Approved" / "Skipped").
            This is the loop made visible: the workflow you built on the left is
            exactly what routes the invoice here. Shown once a run is underway, above
            the detailed text timeline. */}
            {state.status !== "idle" && graphToShow && (
              <div className="mb-4">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
                  Routing through {graphToShow.name}
                </p>
                <div
                  data-testid="live-graph"
                  className="h-[440px] overflow-hidden rounded-xl bg-subtle/30 ring-1 ring-inset ring-line sm:h-64"
                >
                  <WorkflowGraph
                    workflow={graphToShow}
                    statuses={graphStatuses}
                    // When >1 gate pends in parallel, each pending node gets inline
                    // Approve/Reject (decide one, reject another). A single gate uses
                    // the header buttons, so the graph stays read-only there.
                    decidableIds={gates.length >= 2 ? pendingIds : undefined}
                    decisions={gates.length >= 2 ? gateChoices : undefined}
                    onDecide={gates.length >= 2 ? setGate : undefined}
                    // Pan to frame the waiting gate(s) the moment the run pauses.
                    focusIds={awaiting ? pendingIds : undefined}
                  />
                </div>
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
