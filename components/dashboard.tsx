"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CollapsedIntake } from "@/components/dashboard/collapsed-intake";
import { OutcomeBanner } from "@/components/dashboard/outcome-banner";
import { PlayIcon } from "@/components/dashboard/play-icon";
import { QueueHint } from "@/components/dashboard/queue-hint";
import { RunningAgainst } from "@/components/dashboard/running-against";
import { Spinner } from "@/components/dashboard/spinner";
import { TraceDrawer } from "@/components/dashboard/trace-drawer";
import { readIntake, readRecommendation, readRunGraph } from "@/components/dashboard/trace-read";
import { ExtractionReveal } from "@/components/extraction-reveal";
import { RecentRuns } from "@/components/recent-runs";
import { TraceTimeline } from "@/components/trace-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkflowGraph } from "@/components/workflow-graph";
import type { QueueItem } from "@/db/client";
import { useEventCallback } from "@/hooks/use-event-callback";
import { API_ROUTES } from "@/lib/api-routes";
import { type ApprovalWorkflow as TApprovalWorkflow } from "@/lib/approval-workflow";
import { DEFAULT_APPROVAL_POLICY, workflowFromPolicy } from "@/lib/client-profile";
import {
  outcomeDot,
  outcomeLabel,
  outcomeTone,
  scenarioExplain,
  type Outcome,
} from "@/lib/display";
import { formatMoney } from "@/lib/format";
import { client, orpc } from "@/lib/orpc/client";
import { pendingGates } from "@/lib/run-outcome";
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
 *
 * The pure trace-reading helpers (readIntake, readRunGraph, readRecommendation) and
 * the leaf sub-components (PlayIcon, Spinner, QueueHint, OutcomeBanner,
 * CollapsedIntake, RunningAgainst, TraceDrawer) live in ./dashboard/*.
 */
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
  const [selectedId, setSelectedId] = useState<string | null>(queue[0]?.id ?? null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlRunId = searchParams.get("run");

  // The URL is the source of truth for WHICH run instance is on screen. A fresh run
  // writes its generated id into `?run=` the moment it starts (so a mid-run refresh
  // re-hydrates), and the read-effect below turns any `?run=` into a replay. Both the
  // "Recent runs" click and a shared link funnel through the SAME URL path.
  //
  // `ownRunRef` records an id THIS tab is running live (not yet saved to the audit
  // log until it finishes). The read-effect skips it, so we don't try to replay our
  // own in-flight run (which would 404, it isn't stored yet) and don't clobber the URL.
  const loadedRunRef = useRef<string | null>(null);
  const ownRunRef = useRef<string | null>(null);
  const setRunUrl = useEventCallback((runId: string | null, own: boolean = false) => {
    if (own && runId) ownRunRef.current = runId;
    const url = runId ? `${pathname}?run=${encodeURIComponent(runId)}` : pathname;
    router.push(url, { scroll: false });
  });

  const { state, run, decideMany, reset, replay } = usePipelineRun(
    workflow,
    // On a fresh run start, put its instance id in the URL (refresh-safe, shareable),
    // flagged `own` so the read-effect doesn't try to replay our own live run.
    (runId) => setRunUrl(runId, true)
  );
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

  // URL → replay. When `?run=<id>` points at a STORED run we haven't loaded (a
  // refresh, a shared link, a "Recent runs" click), fetch its trace and render it.
  // Skip our own live run (`ownRunRef`): it isn't in the audit log until it finishes,
  // so replaying it would 404 (the live stream already owns the screen). `loadedRunRef`
  // dedupes so a re-render doesn't re-fetch the same id.
  useEffect(() => {
    if (!urlRunId || urlRunId === loadedRunRef.current || urlRunId === ownRunRef.current) return;
    loadedRunRef.current = urlRunId;
    let cancelled = false;
    void client
      .replayRun({ id: urlRunId })
      .then((stored) => {
        if (cancelled) return;
        const row = queue.find((q) => q.invoiceNumber === stored.invoiceNumber);
        if (row) setSelectedId(row.id);
        replay(stored.trace, urlRunId);
      })
      .catch(() => {
        // Not found (a stale/expired id, or reset since): let the id go so a retry can
        // re-fetch, but leave the URL alone rather than yanking it out from under a
        // shared link the user may just be early to.
        if (!cancelled) loadedRunRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [urlRunId, queue, replay]);

  // Queue scroll affordance: macOS hides overlay scrollbars, so we show an
  // explicit "N more" pill + fade until the list is scrolled to the bottom.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [scroll, setScroll] = useState({ hiddenBelow: 0, atBottom: true });

  const measureScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
    setScroll({
      hiddenBelow: Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop),
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
  const moreCount = scroll.atBottom ? 0 : Math.max(1, Math.round(scroll.hiddenBelow / ROW_PX));

  const selected = queue.find((q) => q.id === selectedId) ?? null;
  // Lock the queue while a run is in flight, switching invoices mid-run would
  // abort the stream and is confusing. (Awaiting a human decision still locks:
  // resolve it with Approve/Reject first.)
  // A run is on screen (live, awaiting a decision, or a replayed one) whenever the trace
  // has events. Selecting another invoice is always allowed, it aborts the stream and
  // starts clean; what we DON'T do while a run is shown is let a hover swap the pane out
  // from under it.
  const runShown = state.trace.length > 0;

  // Hovering a row previews its PDF on the right, but only when NO run is shown (idle):
  // once a run is on the pane the header + document stay on the selected invoice, a hover
  // over another row doesn't override them. Falls back to the selected row.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const previewId = (!runShown && hoveredId) || selectedId;
  // The trace-pane title follows whatever document is shown (hover preview or the
  // selected/running invoice) so the header never contradicts the PDF on screen.
  const previewItem = queue.find((q) => q.id === previewId) ?? selected;

  // The live run graph: once the run reaches approval it carries the workflow +
  // each step's status, so we light up the SAME canvas onboarding draws. Before
  // that (or on a run with no active workflow) we draw the active workflow idle, so
  // the user sees their workflow waiting to route. Null when there's nothing to draw.
  // Derive the run graph from the trace. MEMOIZED on the trace: readRunGraph +
  // resolvePath build a NEW workflow object every call, so without this every unrelated
  // re-render (e.g. hovering a queue row) handed WorkflowGraph a fresh `workflow`
  // reference, which reset its layout and re-fit the view, the graph visibly "reset"
  // on hover. Keyed on the trace identity (the only input), so it's stable until the
  // run actually advances.
  const runGraphNow = useMemo(() => readRunGraph(state.trace), [state.trace]);
  // LATCH the resolved run graph across a resume. On Approve+Submit the trace
  // re-streams from the top, so for a beat `readRunGraph` finds no approval event yet
  // and would fall back to the generic full workflow (the graph visibly "swaps" to the
  // default DAG mid-resume). Keep the last resolved graph until a new one arrives or
  // the run resets, so the lit path stays put through the re-stream.
  const runGraphLatch = useRef<ReturnType<typeof readRunGraph>>(null);
  if (runGraphNow) runGraphLatch.current = runGraphNow;
  if (state.status === "idle" || state.trace.length === 0) runGraphLatch.current = null;
  const runGraph = runGraphNow ?? runGraphLatch.current;
  // The graph is the hero and always drawn: the run's lit workflow if a run has
  // reached approval, else the active derived workflow, else the default DAG (so a
  // cold visit with no onboarding still shows what an invoice will route through). The
  // default is memoized so the fallback reference is stable too (same reset concern).
  const defaultGraph = useMemo(() => workflowFromPolicy(DEFAULT_APPROVAL_POLICY), []);
  const graphToShow = runGraph?.workflow ?? workflow ?? defaultGraph;
  const graphStatuses = runGraph?.statuses;

  // Has the document been READ and the run moved on? The extraction reveal is a
  // MOMENT (the AI reading a real PDF): it owns the pane while it happens, then,
  // once matching/a later stage has started, it collapses to a one-line "Intake"
  // node at the top of the trace, handing the pane to the workflow (the hero).
  // `doneIntake` is the read document ONCE the run is past intake (else null), so
  // it both flags the phase and carries the data the collapsed node needs.
  const intake = readIntake(state.trace);
  const movedPastIntake = state.trace.some((e) => e.stage !== "intake" && e.kind !== "run");
  const doneIntake = intake && intake.state.status === "done" && movedPastIntake ? intake : null;

  // Hold the full-screen extraction reveal for a beat AFTER the read completes, so
  // the extracted figures are actually READABLE before the pane collapses to the
  // one-line intake node and hands over to the graph. Matching fires almost
  // instantly, so without this grace window the reveal flashes and is gone.
  //
  // `intakeDoneAtRef` records WHEN the read first completed (keyed on the invoice, so
  // a re-render mid-hold doesn't reset it); a one-shot timer re-renders once the
  // window elapses. `revealHeld` is derived from the ref each render, so React state
  // stays a single boolean tick and can't get stuck.
  const REVEAL_HOLD_MS = 3500;
  const intakeDoneAtRef = useRef<{ key: string; at: number } | null>(null);
  const [, forceTick] = useState(0);
  // Only hold for a LIVE run's read. A replayed stored run jumps straight to `done`
  // with a full trace, nothing was read live, so holding the reveal there just makes
  // opening a past run look like it re-parses the document (it doesn't).
  const doneKey = doneIntake && !state.replayed ? doneIntake.document.invoiceNumber : null;
  useEffect(() => {
    if (doneKey === null) {
      intakeDoneAtRef.current = null;
      return;
    }
    if (intakeDoneAtRef.current?.key === doneKey) return; // already timing
    intakeDoneAtRef.current = { key: doneKey, at: Date.now() };
    const t = setTimeout(() => forceTick((n) => n + 1), REVEAL_HOLD_MS);
    return () => clearTimeout(t);
  }, [doneKey]);

  const holdRec = intakeDoneAtRef.current;
  const revealHeld =
    holdRec !== null && holdRec.key === doneKey && Date.now() - holdRec.at < REVEAL_HOLD_MS;

  // Past intake once the read is done AND its reveal grace window has elapsed. Until
  // then the reveal owns the pane so the figures can be read. A REPLAYED run is a
  // completed run opened for viewing: skip the reveal entirely and go straight to the
  // graph/result (the document stays one click away in the trace drawer), so opening
  // a past run never looks like it re-reads the PDF.
  const pastIntakeNow = state.replayed || (doneIntake !== null && !revealHeld);
  // LATCH it: once a run has handed the pane to the graph it must not flicker back to
  // the reveal mid-run. During the matching→approval transition `doneIntake` can blink
  // null for a render (events reshuffle), which briefly flashed the document overlay
  // back over the graph. The latch clears when the trace empties (reset / new invoice).
  const pastIntakeLatch = useRef(false);
  if (pastIntakeNow) pastIntakeLatch.current = true;
  if (state.status === "idle" || state.trace.length === 0) pastIntakeLatch.current = false;
  const pastIntake = pastIntakeNow || pastIntakeLatch.current;

  // The gates the paused run is waiting on (joined: live status + the workflow's
  // people). Drives the inline per-node Approve/Reject and the submit affordance.
  const gates =
    state.status === "awaiting" && graphStatuses
      ? pendingGates(graphStatuses, graphToShow.steps)
      : [];
  const pendingIds = gates.map((g) => g.id);

  // Decisions staged on the parallel gates, before the reviewer submits the wave.
  // (One gate → the header buttons resume immediately; this is for 2+ at once.)
  const [gateChoices, setGateChoices] = useState<Record<string, "approve" | "reject">>({});
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
    setGateChoices((m) => ({ ...m, [id]: choice }))
  );
  // A gate flipped back to approve drops any reject note it had staged.
  const setGateReason = useEventCallback((id: string, reason: string) =>
    setGateReasons((m) => ({ ...m, [id]: reason }))
  );
  const setAllGates = (choice: "approve" | "reject") =>
    setGateChoices(Object.fromEntries(pendingIds.map((id) => [id, choice])));
  const allDecided = gates.length > 0 && pendingIds.every((id) => gateChoices[id]);
  // Only notes on gates still staged as reject go out (approve drops the note).
  const rejectReasons = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(gateReasons).filter(([id, r]) => gateChoices[id] === "reject" && r.trim())
    );

  const select = (id: string) => {
    if (id === selectedId) return;
    setSelectedId(id);
    setGateChoices({});
    setGateReasons({});
    setTraceOpen(false);
    reset();
    // Leaving a run for a fresh invoice: drop `?run=` so a refresh starts clean.
    loadedRunRef.current = null;
    if (urlRunId) setRunUrl(null);
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
          <Card className="flex max-h-[70vh] flex-col overflow-hidden lg:max-h-none lg:min-h-0 lg:flex-1">
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Invoice queue</CardTitle>
              <span className="tnum text-[11px] text-muted">{queue.length} invoices</span>
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
                  const outcome: Outcome = isSelected ? state.outcome : "pending";
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
                      onMouseLeave={() => setHoveredId((h) => (h === item.id ? null : h))}
                      className={`relative flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                        isSelected ? "bg-accent-soft/50" : "hover:bg-subtle/70"
                      }`}
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
                            <Badge tone={outcomeTone(outcome)}>{outcomeLabel(outcome)}</Badge>
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
                      {explain ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{row}</TooltipTrigger>
                          <TooltipContent side="top" align="end" data-testid={`why-${item.id}`}>
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

          {/* The audit trail: recent runs. Clicking one navigates to its `?run=<id>`,
              and the URL read-effect replays it, so a click, a refresh, and a shared
              link all take the exact same path. */}
          <RecentRuns onOpen={(id) => setRunUrl(id)} />
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
              // The AI investigator's call, shown on the paused gate where the human
              // decides (verdict + reasoning on hover), not only in the trace drawer.
              recommendation={awaiting ? readRecommendation(state.trace) : null}
              // Pan to frame the waiting gate(s) the moment the run pauses.
              focusIds={awaiting ? pendingIds : undefined}
            />

            {/* Top-left overlay: the context a header used to carry (which workflow,
              which invoice) plus, once resolved, the outcome banner, stacked on their
              own lines so nothing overlaps the caption or the View-trace button. Width
              is bounded (leaving room for View-trace on the right) so the banner's why
              wraps instead of overflowing the pane. */}
            <div className="pointer-events-none absolute left-4 right-28 top-3">
              <p className="truncate text-[12px] font-medium text-ink">
                {previewItem ? previewItem.vendor : "Invoice pipeline"}
                {previewItem && (
                  <span className="ml-1.5 font-mono text-[11px] text-faint">
                    {previewItem.invoiceNumber}
                  </span>
                )}
              </p>
              <div className="pointer-events-auto">
                <RunningAgainst workflow={workflow} onBuildWorkflow={onBuildWorkflow} />
              </div>
              {pastIntake && (
                <div className="mt-2 w-fit max-w-full">
                  <OutcomeBanner outcome={state.outcome} />
                </div>
              )}
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
              // The overlay is the positioning context (`inset-0`), and it does NOT
              // scroll, only the inner document does. So the Run CTA, anchored to the
              // overlay's vertical center below, stays put no matter how far the PDF
              // is scrolled (previously it sat at the bottom of the tall, scrolling
              // card and was pushed off-screen).
              <div className="absolute inset-0 z-10 bg-canvas">
                {/* pt-3 matches the graph pane's caption inset (top-3) so the document
                    top lines up with where the workflow starts, not ~20px below it. */}
                <div className="h-full overflow-y-auto px-5 pb-5 pt-3">
                  <div className="mx-auto w-full max-w-2xl pb-20">
                    <ExtractionReveal
                      pdfSrc={API_ROUTES.pdf(previewId)}
                      state={
                        intake?.state ??
                        (state.status === "running"
                          ? {
                              status: "running",
                              extracted: null,
                              matches: false,
                            }
                          : null)
                      }
                      extractedInvoice={intake?.document ?? null}
                    />
                  </div>
                </div>
                {/* Run CTA: pinned to the overlay's VERTICAL CENTER over the scroll,
                    so it's always in the same reachable spot no matter how far the
                    document is scrolled (was stranded at the bottom of the tall
                    scrolling card before). */}
                {state.status === "idle" && selected && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    {/* A soft blurred halo behind the CTA so it reads clearly over the
                        document text it floats on (the button otherwise collided with
                        an invoice line and was hard to read). */}
                    <div className="pointer-events-auto rounded-full bg-canvas/40 p-3 backdrop-blur-md">
                      <Button
                        data-testid="run-btn"
                        onClick={() => run(selected.id)}
                        className="shadow-lift"
                      >
                        <PlayIcon />
                        Run pipeline
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Floating action bar while a run is paused on gate(s): the resume control
              that used to live in the header. Decide on the nodes, submit here. */}
            {awaiting && selected && (
              <div
                data-testid={gates.length >= 2 ? "approval-gate-multi" : "approval-gate"}
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
