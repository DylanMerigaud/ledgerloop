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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkflowGraph, type StepStatuses } from "@/components/workflow-graph";
import type { QueueItem } from "@/db/client";
import { useEventCallback } from "@/hooks/use-event-callback";
import { API_ROUTES } from "@/lib/api-routes";
import { contextFromMatch } from "@/lib/approval-run";
import {
  ApprovalWorkflow,
  resolvePath,
  type ApprovalWorkflow as TApprovalWorkflow,
  type InvoiceContext,
} from "@/lib/approval-workflow";
import { isRecord } from "@/lib/assert";
import {
  DEFAULT_APPROVAL_POLICY,
  workflowFromPolicy,
} from "@/lib/client-profile";
import {
  outcomeDot,
  outcomeLabel,
  outcomeTone,
  scenarioBadge,
  scenarioExplain,
  scenarioKind,
  type Outcome,
} from "@/lib/display";
import { formatMoney } from "@/lib/format";
import { orpc } from "@/lib/orpc/client";
import { pendingGates } from "@/lib/run-outcome";
import { MatchResult, type Invoice } from "@/lib/schema";
import type { TraceEvent } from "@/lib/trace";
import { usePipelineRun } from "@/lib/use-pipeline-run";

/**
 * The split-view dashboard.
 *   LEFT , the invoice queue, each row a seeded invoice with a status pill.
 *   RIGHT, the live agent execution trace for the selected invoice.
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
 * Pipeline can render the SAME graph the onboarding screen draws, lit up by this
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
  // Resolve the LINEAR path THIS invoice takes: evaluate each gate's condition
  // against the matched invoice and drop the ones that don't apply (rewiring edges),
  // so the reviewer sees Manager → Post, not an ambiguous Manager → Director AND
  // Manager → Post diamond. Keyed on the invoice (from the matching event), NOT on
  // approval order, so it's fixed the moment matching resolves and never re-routes as
  // gates get decided. If matching data isn't on the trace yet, draw the full graph.
  const ctx = readMatchContext(trace);
  return { workflow: resolvePath(parsed.data, ctx), statuses };
};

/** Build the approval engine's InvoiceContext from the matching trace event, so the
    run graph's path can be resolved client-side. Returns undefined (draw the full
    graph) if the matching event isn't present/valid yet.

    The matching step emits the MatchResult PLUS run-plumbing (`decisions`, `profile`,
    `narration`, …), so we validate only the MatchResult fields and `.passthrough()`
    the extras, rather than strict-parsing the whole event (which would reject it). */
const MatchResultLoose = MatchResult.passthrough();
const readMatchContext = (trace: TraceEvent[]): InvoiceContext | undefined => {
  const matching = trace.find(
    (e) => e.stage === "matching" && e.kind === "step",
  );
  if (!matching || !isRecord(matching.data)) return undefined;
  const parsed = MatchResultLoose.safeParse(matching.data);
  return parsed.success ? contextFromMatch(parsed.data) : undefined;
};

/** Solid play triangle for the Run button. */
const PlayIcon = () => {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 fill-current">
      <path d="M3 1.8v8.4a.6.6 0 0 0 .92.5l6.4-4.2a.6.6 0 0 0 0-1L3.92 1.3A.6.6 0 0 0 3 1.8Z" />
    </svg>
  );
};

/**
 * The pre-run hint on a queue row: a "Start here" chip on the showcase invoice,
 * and a coloured badge ONLY for exception/blocked scenarios (clean rows stay
 * unmarked, so the marks draw the eye to the cases worth running). Renders nothing
 * for an unmarked clean row.
 */
const QueueHint = ({
  scenario,
  startHere,
}: {
  scenario: string | null;
  startHere: boolean;
}) => {
  const badge = scenarioBadge(scenarioKind(scenario));
  if (!startHere && !badge) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {startHere && (
        <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent ring-1 ring-inset ring-accent/20">
          <span aria-hidden>⚡</span> Start here
        </span>
      )}
      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
    </span>
  );
};

/**
 * Once the document has been READ and the run moves on, the big extraction reveal
 * (its moment is over) collapses into this one-line node at the top of the trace,
 * "Intake · INV-2042 · 3 lines · $730 · reconciled with PO", expandable to re-show
 * the document + extracted fields. Keeps the AI-reads-the-doc proof one click away
 * while handing the pane to the workflow (the hero).
 */
const CollapsedIntake = ({
  pdfSrc,
  document,
  state,
}: {
  pdfSrc: string;
  document: Invoice;
  state: ExtractionState;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 rounded-lg ring-1 ring-inset ring-line">
      <button
        type="button"
        data-testid="intake-collapsed"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-subtle/50"
      >
        <span aria-hidden className="text-ok">
          ✓
        </span>
        <span className="font-medium text-ink">Intake</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {document.vendor} · {document.lineItems.length} lines ·{" "}
          {formatMoney(document.total, document.currency)}
        </span>
        {state.matches && <Badge tone="ok">reconciled with PO</Badge>}
        <span
          aria-hidden
          className={`text-faint transition-transform ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          <ExtractionReveal
            pdfSrc={pdfSrc}
            state={state}
            extractedInvoice={document}
          />
        </div>
      )}
    </div>
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
 * "Running against: <workflow>", the line that makes the link to onboarding
 * visible: the pipeline routes every invoice through this exact workflow. Shows
 * the active workflow's name once discovery/edits have produced one; otherwise a
 * quiet note that the default DAG is in use until the user derives theirs.
 */
const RunningAgainst = ({
  workflow,
  onBuildWorkflow,
}: {
  workflow: TApprovalWorkflow | null;
  /** Jump back to the "Build the workflow" tab to run discovery. */
  onBuildWorkflow: () => void;
}) => {
  if (!workflow) {
    return (
      <p className="mt-1 text-[11px] text-faint">
        Default workflow.{" "}
        <button
          type="button"
          onClick={onBuildWorkflow}
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Build your own
        </button>{" "}
        to route against it.
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
  onBuildWorkflow,
}: {
  queue: QueueItem[];
  /** The active approval workflow this pipeline runs against (lifted from
      onboarding via AppView). null until discovery has run, the server then falls
      back to its default DAG. */
  workflow: TApprovalWorkflow | null;
  /** Switch to the "Build the workflow" tab (the trace's no-workflow hint links here). */
  onBuildWorkflow: () => void;
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(
    queue[0]?.id ?? null,
  );
  const { state, run, decideMany, reset, replay } = usePipelineRun(workflow);
  const queryClient = useQueryClient();

  // When a run reaches a terminal state (done/blocked, not a mid-run pause), a new
  // audit row exists, refresh the Recent runs list so it shows up. Keyed off the
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
  // Lock the queue while a run is in flight, switching invoices mid-run would
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
  // The graph is the hero and always drawn: the run's lit workflow if a run has
  // reached approval, else the active derived workflow, else the default DAG (so a
  // cold visit with no onboarding still shows what an invoice will route through).
  const graphToShow =
    runGraph?.workflow ??
    workflow ??
    workflowFromPolicy(DEFAULT_APPROVAL_POLICY);
  const graphStatuses = runGraph?.statuses;

  // Has the document been READ and the run moved on? The extraction reveal is a
  // MOMENT (the AI reading a real PDF): it owns the pane while it happens, then,
  // once matching/a later stage has started, it collapses to a one-line "Intake"
  // node at the top of the trace, handing the pane to the workflow (the hero).
  // `doneIntake` is the read document ONCE the run is past intake (else null), so
  // it both flags the phase and carries the data the collapsed node needs.
  const intake = readIntake(state.trace);
  const movedPastIntake = state.trace.some(
    (e) => e.stage !== "intake" && e.kind !== "run",
  );
  const doneIntake =
    intake && intake.state.status === "done" && movedPastIntake ? intake : null;
  const pastIntake = doneIntake !== null;

  // The gates the paused run is waiting on (joined: live status + the workflow's
  // people). Drives the inline per-node Approve/Reject and the submit affordance.
  const gates =
    state.status === "awaiting" && graphStatuses
      ? pendingGates(graphStatuses, graphToShow.steps)
      : [];
  const pendingIds = gates.map((g) => g.id);

  // Decisions staged on the parallel gates, before the reviewer submits the wave.
  // (One gate → the header buttons resume immediately; this is for 2+ at once.)
  const [gateChoices, setGateChoices] = useState<
    Record<string, "approve" | "reject">
  >({});
  // Reject notes staged per gate (multi-gate), keyed by step id.
  const [gateReasons, setGateReasons] = useState<Record<string, string>>({});
  // The trace drawer (the step-by-step log) slides over the graph on demand, so the
  // graph stays the full-width hero and the trace gets real width when you open it.
  const [traceOpen, setTraceOpen] = useState(false);
  // Clear all staged decision/reason state whenever the run leaves the awaiting
  // state (resolved, re-run, or a new wave streams in fresh) so nothing leaks.
  const awaiting = state.status === "awaiting";
  const wasAwaitingRef = useRef(false);
  useEffect(() => {
    if (wasAwaitingRef.current && !awaiting) {
      setGateChoices({});
      setGateReasons({});
    }
    wasAwaitingRef.current = awaiting;
  }, [awaiting]);

  const setGate = useEventCallback((id: string, choice: "approve" | "reject") =>
    setGateChoices((m) => ({ ...m, [id]: choice })),
  );
  // A gate flipped back to approve drops any reject note it had staged.
  const setGateReason = useEventCallback((id: string, reason: string) =>
    setGateReasons((m) => ({ ...m, [id]: reason })),
  );
  const setAllGates = (choice: "approve" | "reject") =>
    setGateChoices(Object.fromEntries(pendingIds.map((id) => [id, choice])));
  const allDecided =
    gates.length > 0 && pendingIds.every((id) => gateChoices[id]);
  // Only notes on gates still staged as reject go out (approve drops the note).
  const rejectReasons = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(gateReasons).filter(
        ([id, r]) => gateChoices[id] === "reject" && r.trim(),
      ),
    );

  const select = (id: string) => {
    if (id === selectedId || locked) return;
    setSelectedId(id);
    setGateChoices({});
    setGateReasons({});
    setTraceOpen(false);
    reset();
  };

  // Submit the staged gate decisions (one gate or several). decideMany rebuilds the
  // stateless run from the union of decisions, so it covers the single-gate case too.
  const submitDecisions = () => {
    if (!selected || !allDecided) return;
    void decideMany(selected.id, gateChoices, rejectReasons());
  };

  return (
    // Desktop: fill the parent's flex-1 slot (the page is viewport-tall), so the
    // two panes sit side by side and scroll INTERNALLY, no competing page
    // scroll. Mobile: stack at natural height.
    <TooltipProvider delayDuration={200}>
      <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(300px,380px)_1fr]">
        {/* LEFT, queue (fills the column) + the Recent runs audit panel below it. */}
        <div className="flex min-h-0 flex-col gap-4 lg:h-full">
          <Card className="flex max-h-[70vh] flex-col overflow-hidden lg:min-h-0 lg:max-h-none lg:flex-1">
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Invoice queue</CardTitle>
              <span className="text-[11px] text-muted tnum">
                {queue.length} invoices
              </span>
            </CardHeader>
            {/* relative wrapper so the fade + "N more" pill can overlay the scroll
        area, on macOS the overlay scrollbar is hidden, so these are the cue
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
                  const outcome: Outcome = isSelected
                    ? state.outcome
                    : "pending";
                  // While a run is in flight the queue is locked: the active row stays
                  // highlighted, the others dim and stop responding to clicks.
                  const dimmed = locked && !isSelected;
                  // Hovering a flagged row reveals WHY in plain English (a Radix tooltip),
                  // so the queue explains itself before you run anything. Clean rows have
                  // nothing to explain.
                  const explain = scenarioExplain(item.scenario);
                  const row = (
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
                      outcome badge; otherwise signpost the seeded scenario so the
                      eye goes to the interesting cases. Only exception/blocked rows
                      get a coloured badge, clean rows stay unmarked, so the marks
                      mean something. INV-2042 (price mismatch → investigator +
                      pause: the full wow) also gets a single "Start here" chip. */}
                          {isSelected && state.status !== "idle" ? (
                            <Badge tone={outcomeTone(outcome)}>
                              {outcomeLabel(outcome)}
                            </Badge>
                          ) : (
                            <QueueHint
                              scenario={item.scenario}
                              startHere={item.id === "INV-2042"}
                            />
                          )}
                        </span>
                      </span>
                    </button>
                  );
                  return (
                    <li key={item.id}>
                      {explain && !locked ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{row}</TooltipTrigger>
                          <TooltipContent
                            side="top"
                            align="end"
                            data-testid={`why-${item.id}`}
                          >
                            {explain}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        row
                      )}
                    </li>
                  );
                })}
              </ul>
              {/* "N more" scroll affordance: a pill that scrolls the list when clicked.
          Hidden once the list is at the bottom. (No fade, the rows are short and it
          ate into the last row.) */}
              {moreCount > 0 && (
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
              )}
            </div>
          </Card>

          {/* The audit trail: recent runs, each replayable into the trace pane. */}
          <RecentRuns onReplay={replayRun} disabled={locked} />
        </div>

        {/* RIGHT: the workflow graph is the hero and owns the whole pane. No header,
          its controls live ON the canvas: a centered Run before a run, inline
          Approve/Reject on the gate nodes when it pauses, a floating Submit bar to
          resume, and a "View trace" button that opens the step log in a drawer. */}
        <Card className="relative flex flex-col overflow-hidden">
          {/* The graph, full-bleed. Always drawn (the active or default workflow), so
            even idle the user sees the DAG their invoice will route through. */}
          <div className="relative min-h-0 flex-1" data-testid="graph-pane">
            <WorkflowGraph
              workflow={graphToShow}
              statuses={graphStatuses}
              // The awaiting gate(s) accept a decision inline; one gate or several, the
              // node carries Approve / Reject (+ a reason on a staged reject).
              decidableIds={awaiting ? pendingIds : undefined}
              decisions={awaiting ? gateChoices : undefined}
              reasons={awaiting ? gateReasons : undefined}
              onDecide={awaiting ? setGate : undefined}
              onReason={awaiting ? setGateReason : undefined}
              // Pan to frame the waiting gate(s) the moment the run pauses.
              focusIds={awaiting ? pendingIds : undefined}
            />

            {/* Top-left overlay: the context a header used to carry (which workflow,
              which invoice), as a quiet caption over the canvas. */}
            <div className="pointer-events-none absolute left-4 top-3 max-w-[60%]">
              <p className="truncate text-[12px] font-medium text-ink">
                {previewItem ? previewItem.vendor : "Invoice pipeline"}
                {previewItem && (
                  <span className="ml-1.5 font-mono text-[11px] text-faint">
                    {previewItem.invoiceNumber}
                  </span>
                )}
              </p>
              <div className="pointer-events-auto">
                <RunningAgainst
                  workflow={workflow}
                  onBuildWorkflow={onBuildWorkflow}
                />
              </div>
            </div>

            {/* Top-right overlay: "View trace" once a run has produced any trace. */}
            {state.status !== "idle" && (
              <button
                type="button"
                data-testid="view-trace"
                onClick={() => setTraceOpen(true)}
                className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-surface/90 px-3 py-1.5 text-[12px] font-medium text-muted shadow-card ring-1 ring-inset ring-line-strong backdrop-blur transition-colors hover:text-ink"
              >
                View trace
              </button>
            )}

            {/* Before the run is past intake, the INVOICE owns the pane: the selected
              document on idle (with Run), then the live scan as the agent reads it.
              Once past intake it's gone and the lit graph is the whole story (the
              document stays one click away in the trace drawer). */}
            {!pastIntake && previewId && (
              <div className="absolute inset-0 z-10 grid place-items-center overflow-y-auto bg-canvas p-5">
                {/* `relative` so the Run CTA can float over the document card's own
                    corner (an anchored overlay, NOT a button stranded below the
                    card). The card owns the pane; the action sits on it. */}
                <div className="relative w-full max-w-2xl">
                  <ExtractionReveal
                    pdfSrc={API_ROUTES.pdf(previewId)}
                    state={
                      intake?.state ??
                      (state.status === "running"
                        ? { status: "running", extracted: null, matches: false }
                        : null)
                    }
                    extractedInvoice={intake?.document ?? null}
                  />
                  {state.status === "idle" && selected && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
                      <Button
                        data-testid="run-btn"
                        onClick={() => run(selected.id)}
                        className="pointer-events-auto shadow-lift"
                      >
                        <PlayIcon />
                        Run pipeline
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Floating action bar while a run is paused on gate(s): the resume control
              that used to live in the header. Decide on the nodes, submit here. */}
            {awaiting && selected && (
              <div
                data-testid={
                  gates.length >= 2 ? "approval-gate-multi" : "approval-gate"
                }
                className="absolute inset-x-0 bottom-4 z-10 mx-auto flex w-fit items-center gap-2 rounded-full bg-ink/90 px-2 py-1.5 shadow-lift backdrop-blur"
              >
                {gates.length >= 2 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setAllGates("reject")}
                      className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white/80 hover:text-white"
                    >
                      Reject all
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllGates("approve")}
                      className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white/80 hover:text-white"
                    >
                      Approve all
                    </button>
                  </>
                )}
                <span className="px-1 text-[12px] text-white/60">
                  {gates.length >= 2
                    ? `${pendingIds.filter((id) => gateChoices[id]).length}/${gates.length} decided`
                    : "Decide on the gate"}
                </span>
                <Button
                  size="sm"
                  variant="ok"
                  data-testid="submit-decisions"
                  disabled={!allDecided}
                  onClick={submitDecisions}
                >
                  {gates.length >= 2 ? "Submit decisions" : "Submit"}
                </Button>
              </div>
            )}

            {/* The running indicator (the centered Run is gone once a run starts). */}
            {state.status === "running" && pastIntake && (
              <div className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 rounded-full bg-surface/90 px-3 py-1.5 text-[12px] font-medium text-muted shadow-card ring-1 ring-inset ring-line-strong backdrop-blur">
                <Spinner />
                Running…
              </div>
            )}
          </div>

          {/* The trace drawer: slides over the graph, the full step log at real width. */}
          <TraceDrawer
            open={traceOpen}
            onClose={() => setTraceOpen(false)}
            invoiceLabel={previewItem?.invoiceNumber ?? null}
          >
            {doneIntake && previewId && (
              <CollapsedIntake
                pdfSrc={API_ROUTES.pdf(previewId)}
                document={doneIntake.document}
                state={doneIntake.state}
              />
            )}
            <TraceTimeline
              state={state}
              invoiceLabel={selected?.invoiceNumber ?? null}
              canRun={!!selected}
              onRun={() => selected && run(selected.id)}
            />
          </TraceDrawer>
        </Card>
      </div>
    </TooltipProvider>
  );
};

/** A minimal right-side drawer that slides over the graph with the trace log. Scrim
    closes it, Esc closes it, body scroll is locked while open. */
const TraceDrawer = ({
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
            <p className="text-[13px] font-semibold text-ink">
              Agent execution trace
            </p>
            {invoiceLabel && (
              <p className="truncate font-mono text-[11px] text-faint">
                {invoiceLabel}
              </p>
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
        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {children}
        </div>
      </div>
    </div>
  );
};
