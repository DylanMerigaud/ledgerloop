"use client";

import {
  Background,
  type Edge,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";

import type { NodeData } from "@/components/workflow-graph/node-data";
import type { ApprovalWorkflow, StepChange } from "@/lib/approval-workflow";
import type { WorkflowIssue } from "@/lib/workflow-validate";

import { estimateHeight, layout } from "@/components/workflow-graph/layout";
import { nodeTypes } from "@/components/workflow-graph/step-node";
import { REACHED, type StepStatuses } from "@/components/workflow-graph/visual-map";
import { useEventCallback } from "@/hooks/use-event-callback";
import { useMediaQuery } from "@/hooks/use-media-query";

export type { StepStatuses } from "@/components/workflow-graph/visual-map";

/**
 * The approval workflow as a real flow canvas (React Flow), laid out left→right by
 * dagre. The category convention is a node-and-edge canvas; this is that, in the
 * app's own card style. Nodes are VARIABLE height (a 2-line title or a `when` chip
 * makes a card taller), so we render them hidden first, let React Flow MEASURE each
 * card, then run dagre with the real heights and reveal, the measured pattern from
 * reactflow-auto-layout. Wiring `onNodesChange` (via useNodesState) is what lets the
 * measurements flow back so `useNodesInitialized` flips and the layout runs.
 *
 * The same component renders three things off one workflow: the derived workflow
 * (onboarding), a proposed edit (diff colours via `changes`), and a live run
 * (per-step status colours via `statuses`).
 */

/* ── the graph ─────────────────────────────────────────────────────────────── */

const Inner = ({
  workflow,
  statuses,
  changes,
  issues,
  onNodeSelect,
  selectedId,
  decisions,
  decidableIds,
  reasons,
  onDecide,
  onReason,
  recommendation,
  focusIds,
}: WorkflowGraphProps) => {
  // Stack the DAG vertically below the `sm` breakpoint (640px), where a wide
  // left→right layout can't fit, each node then gets the full column width.
  const isVertical = useMediaQuery("(max-width: 639px)");

  const changeOf = useMemo(() => new Map((changes ?? []).map((c) => [c.id, c.kind])), [changes]);

  // Highest-severity issue per step id (error beats warning), for the node rings.
  const issueOf = useMemo(() => {
    const m = new Map<string, "error" | "warning">();
    for (const iss of issues ?? [])
      for (const id of iss.stepIds) {
        if (iss.severity === "error" || !m.has(id)) m.set(id, iss.severity);
      }
    return m;
  }, [issues]);

  // Removed steps aren't in `steps`, synthesize a node from the diff so the
  // preview shows what's going away.
  const removed = useMemo(() => (changes ?? []).filter((c) => c.kind === "removed"), [changes]);

  const initialNodes = useMemo<Node<NodeData>[]>(() => {
    // Connectivity from the rendered node set: a node HAS an incoming edge if some
    // present step lists it in `next`; HAS an outgoing edge if its own `next` points
    // at a present node. Used to drop the dangling handle on roots (no incoming) and
    // leaves like the terminal Post (no outgoing).
    const present = new Set(workflow.steps.map((s) => s.id));
    const targets = new Set<string>();
    for (const s of workflow.steps) for (const n of s.next) if (present.has(n)) targets.add(n);

    const real = workflow.steps.map((step) => ({
      id: step.id,
      type: "step",
      position: { x: 0, y: 0 },
      data: {
        step,
        status: statuses?.[step.id],
        change: changeOf.get(step.id),
        issue: issueOf.get(step.id),
        vertical: isVertical,
        hasIncoming: targets.has(step.id),
        hasOutgoing: step.next.some((n) => present.has(n)),
      },
    }));
    const gone = removed.map((c) => ({
      id: c.id,
      type: "step",
      position: { x: 0, y: 0 },
      data: {
        step: {
          id: c.id,
          kind: "approval" as const,
          label: c.label,
          when: { kind: "always" as const },
          approverTitle: "",
          approverName: null,
          next: [],
        },
        change: "removed" as const,
        vertical: isVertical,
      },
    }));
    return [...real, ...gone];
  }, [workflow, statuses, changeOf, removed, issueOf, isVertical]);

  // Structural edges only (no status) so the layout/reset path never re-fires on a
  // status change, the live "flow" styling is patched separately below.
  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    for (const s of workflow.steps)
      for (const n of s.next)
        out.push({
          id: `${s.id}->${n}`,
          source: s.id,
          target: n,
          // Rounded elbow connectors (like the reference) instead of beziers.
          type: "smoothstep",
          animated: false,
          style: { stroke: "#CBCDD4", strokeWidth: 1.5 },
        });
    return out;
  }, [workflow]);

  const { fitView } = useReactFlow<Node<NodeData>>();

  // Controlled node/edge state with React Flow's own reducers, this wires
  // `onNodesChange`, so the ResizeObserver's measurements flow back into the store
  // and `useNodesInitialized` actually flips to true (without onNodesChange it
  // never does, and the layout never runs). Nodes start HIDDEN at 0,0.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>(
    initialNodes.map((n) => ({ ...n, style: { visibility: "hidden" } }))
  );
  // Live mirror of `nodes` so the focus effect can read the current positions (to pick
  // the topmost pending gate) without listing `nodes` as a dep (which would re-fire it).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [rfEdges, setEdges, onEdgesChange] = useEdgesState<Edge>(edges);

  // The one framing rule, shared by the initial layout fit and the later focus effect:
  //   pending gate(s) present → frame the SINGLE topmost one (smallest y, or x when
  //   stacked), tight + zoomed, so the next thing to approve is centered; none present
  //   → fit the WHOLE workflow. Topmost is read from the live node positions.
  const frameForFocus = useEventCallback((pending: string[], ms: number) => {
    if (pending.length > 0) {
      const axis = (id: string): number => {
        const pos = nodesRef.current.find((m) => m.id === id)?.position;
        return pos ? (isVertical ? pos.x : pos.y) : Infinity;
      };
      const top = [...pending].sort((a, b) => axis(a) - axis(b))[0];
      void fitView({
        nodes: top ? [{ id: top }] : pending.map((id) => ({ id })),
        duration: ms,
        padding: 0.25,
        maxZoom: 1.1,
      });
    } else {
      void fitView({ duration: ms, padding: 0.18 });
    }
  });
  // Bumped to force one more layout pass when a node's measured height drifts after the
  // initial layout (see the drift effect below); a dep of the layout effect.
  const [relayoutTick, setRelayoutTick] = useState(0);

  // True once every current node has been measured. Resets when the set changes.
  const isInitialized = useNodesInitialized();

  // When the source graph changes (new discovery / edit), reset to the new nodes
  // HIDDEN so they get re-measured, and mark that this set still needs a layout.
  const laidOutFor = useRef<string>("");
  // The measured heights the current layout was computed from, so a later drift (a
  // few-px settle) can be detected and corrected with a single re-layout.
  const laidOutHeights = useRef<Map<string, number | null>>(new Map());
  // The LATEST measured height per node, updated straight off React Flow's `dimensions`
  // change events (never stale, unlike re-reading node.measured in an effect). The
  // layout reads its heights from here so it always lays out on the true sizes.
  const liveHeights = useRef<Map<string, number>>(new Map());
  // True while the NEXT layout run is a silent drift correction (re-position only, no
  // re-fit), so straightening an edge doesn't zoom the pane on a staged decision.
  const driftRelayout = useRef(false);
  // The graph's container, observed so we can re-fit when it resizes (the editor's
  // bottom stack growing/shrinking, a window resize). fitView otherwise runs once per
  // graph, so without this a node could sit clipped off the edge after a resize.
  const wrapRef = useRef<HTMLDivElement>(null);
  const graphKey = useMemo(
    () =>
      initialNodes.map((n) => n.id).join("|") + "::" + edges.length + (isVertical ? "::v" : "::h"),
    [initialNodes, edges, isVertical]
  );
  useEffect(() => {
    setNodes(initialNodes.map((n) => ({ ...n, style: { visibility: "hidden" } })));
    setEdges(edges);
    laidOutFor.current = ""; // force a fresh layout for the new graph
  }, [initialNodes, edges, setNodes, setEdges]);

  // Once measured, lay out with the REAL (measured) heights, reveal, and fit. The
  // ref guard makes this run once per graph (its own setNodes re-renders but won't
  // re-enter, since the key is already marked done). If the graph appears with a
  // FOCUS group (a paused gate awaiting a decision), frame THAT group instead of the
  // whole graph, so the node you need to act on lands centered the moment the graph
  // shows, not off to one side. The separate focus effect below handles later focus
  // changes (the next gate after an approve); this handles the initial appearance.
  useEffect(() => {
    if (!isInitialized || laidOutFor.current === graphKey) return;
    laidOutFor.current = graphKey;
    // Layout from `liveHeights`, the authoritative measured heights kept up to date by
    // the onNodesChange interceptor below (which reads them straight off React Flow's
    // `dimensions` change events). We do NOT re-read node.measured here: right after a
    // resize it can still be the STALE value for a tick, which is what drifted the edge
    // handles a few px (the connector kink). `liveHeights` is always the latest.
    const heightOf = (n: Node<NodeData>): number =>
      liveHeights.current.get(n.id) ?? estimateHeight(n.data);
    laidOutHeights.current = new Map(
      nodesRef.current.map((n) => [n.id, liveHeights.current.get(n.id) ?? null])
    );
    const laid = layout(initialNodes, edges, heightOf, isVertical);
    const byId = new Map(laid.map((n) => [n.id, n.position]));
    setNodes((cur) =>
      cur.map((n) => {
        const pos = byId.get(n.id);
        return pos
          ? { ...n, position: pos, style: { visibility: "visible" } }
          : { ...n, style: { visibility: "visible" } };
      })
    );
    // A DRIFT re-layout only nudges node positions a few px to straighten edges; it
    // must NOT re-fit the view. Otherwise staging a decision (which tints the card and
    // can drift its measured height by a px) would re-fit and the pane would visibly
    // zoom on the click. The view re-frames only on a real focus change (the initial
    // appearance here, or the next gate after Submit via the focus effect below).
    if (driftRelayout.current) {
      driftRelayout.current = false;
      return;
    }
    requestAnimationFrame(() => frameForFocus(focusIds ?? [], 200));
  }, [
    isInitialized,
    graphKey,
    initialNodes,
    edges,
    setNodes,
    fitView,
    isVertical,
    focusIds,
    frameForFocus,
    relayoutTick,
  ]);

  // Re-layout when React Flow REPORTS a node resized. React Flow emits a `dimensions`
  // change (from its ResizeObserver) the instant a card's measured height changes, so a
  // badge/when-chip/toolbar appearing after the one-shot layout arrives here as a precise
  // event CARRYING the new height. We record it in `liveHeights` (the source of truth the
  // layout reads) and, if it differs from what the current layout used, run ONE more
  // layout pass (positions only, no re-fit) so the node centers, and thus the edge
  // handles, re-align on the TRUE heights. Bounded: after it, the heights match.
  const onNodesChangeWithRelayout = useEventCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      let isResized = false;
      for (const c of changes) {
        if (c.type !== "dimensions" || !c.dimensions) continue;
        liveHeights.current.set(c.id, c.dimensions.height);
        const used = laidOutHeights.current.get(c.id);
        if (used == null || Math.abs(used - c.dimensions.height) > 1) isResized = true;
      }
      if (isResized && laidOutFor.current === graphKey) {
        driftRelayout.current = true; // silent: straighten edges, don't re-fit the view
        laidOutFor.current = "";
        setRelayoutTick((t) => t + 1);
      }
    }
  );

  // Re-fit when the container resizes so nodes never sit clipped past an edge after a
  // layout reflow or window resize. RAF-debounced; skipped until the nodes exist.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!isInitialized) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void fitView({ padding: 0.18 }));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [isInitialized, fitView]);

  // Patch the `selected` halo on the live nodes when the selection changes, cheap,
  // no re-layout (kept out of the layout pipeline so a click doesn't reflow the graph).
  useEffect(() => {
    setNodes((cur) =>
      cur.map((n) =>
        n.data.selected === (n.id === selectedId)
          ? n
          : { ...n, data: { ...n.data, selected: n.id === selectedId } }
      )
    );
  }, [selectedId, setNodes]);

  // Patch the per-gate decision state (decidable + staged choice + the handler) onto
  // live nodes, also cheap, no re-layout, so deciding a gate doesn't reflow the graph.
  // Kept out of `initialNodes` for the same reason (its identity changing forces a
  // re-measure). Keyed on stable strings so it only runs when the inputs change. The
  // decision UI is a floating NodeToolbar (not in the card), so the decidable state no
  // longer changes node height, hence it doesn't feed the layout key anymore.
  const decidableKey = (decidableIds ?? []).join("|");
  const choiceKey = decisions
    ? Object.entries(decisions)
        .map(([k, v]) => `${k}:${v ?? ""}`)
        .sort()
        .join("|")
    : "";
  const reasonKey = reasons
    ? Object.entries(reasons)
        .map(([k, v]) => `${k}:${v}`)
        .sort()
        .join("|")
    : "";
  useEffect(() => {
    const decidable = new Set(decidableIds);
    setNodes((cur) =>
      cur.map((n) => {
        const isDecidable = decidable.has(n.id);
        const choice = decisions?.[n.id] ?? undefined;
        const reason = reasons?.[n.id] ?? undefined;
        const handler =
          isDecidable && onDecide ? (c: "approve" | "reject") => onDecide(n.id, c) : undefined;
        const reasonHandler =
          isDecidable && onReason ? (r: string) => onReason(n.id, r) : undefined;
        // The AI recommendation rides only on a decidable gate (where it helps the
        // decision); other nodes carry none.
        const rec = isDecidable ? (recommendation ?? undefined) : undefined;
        if (
          n.data.decidable === isDecidable &&
          n.data.choice === choice &&
          n.data.reason === reason &&
          n.data.onDecide === handler &&
          n.data.onReason === reasonHandler &&
          n.data.recommendation === rec
        ) {
          return n;
        }
        return {
          ...n,
          data: {
            ...n.data,
            decidable: isDecidable,
            choice: choice ?? undefined,
            reason: reason ?? undefined,
            onDecide: handler,
            onReason: reasonHandler,
            recommendation: rec,
          },
        };
      })
    );
  }, [
    decidableKey,
    choiceKey,
    reasonKey,
    decidableIds,
    decisions,
    reasons,
    onDecide,
    onReason,
    recommendation,
    setNodes,
  ]);

  // Re-frame the view when a run state ARRIVES (not while staging a decision). The rule:
  //   • can approve now (pending gates) → frame the SINGLE topmost pending gate, so the
  //     next thing to act on is centered and zoomed in;
  //   • otherwise (a run just resolved / a replay loaded / posted) → fit the WHOLE
  //     workflow, so the finished path reads at a glance.
  // Keyed on `focusKey` (the pending set), so it fires once when the gate set changes
  // (a run pauses, a resume reaches the next gate, a run completes to none). Clicking
  // Approve/Reject doesn't change the pending set, so the view stays put on a click.
  const focusKey = (focusIds ?? []).join("|");
  useEffect(() => {
    if (!isInitialized || laidOutFor.current !== graphKey) return;
    const raf = requestAnimationFrame(() =>
      frameForFocus(focusKey ? focusKey.split("|") : [], 400)
    );
    return () => cancelAnimationFrame(raf);
  }, [focusKey, isInitialized, graphKey, frameForFocus]);

  // Patch edge "flow" styling from the live statuses, cheap, no relayout (kept out of
  // the structural `edges` so a status tick never resets/re-measures the graph). An edge
  // animates + goes accent when the invoice flowed along it: source passed
  // (approved/done) and target was reached. Keyed on a status signature so it only runs
  // when statuses change.
  const statusKey = statuses
    ? Object.entries(statuses)
        .map(([k, v]) => `${k}:${v}`)
        .sort()
        .join("|")
    : "";
  useEffect(() => {
    const st = statuses ?? {};
    setEdges((cur) =>
      cur.map((e) => {
        const src = st[e.source];
        const isLive = (src === "approved" || src === "done") && REACHED.has(st[e.target] ?? "");
        // A traversed edge reads as a SOLID accent line (no marching-ants animation,
        // which drew the eye and looked busy); an untraversed edge stays quiet grey.
        const stroke = isLive ? "#5B53D6" : "#CBCDD4";
        const strokeWidth = isLive ? 2 : 1.5;
        const prev = e.style ?? {};
        if (e.animated === false && prev.stroke === stroke && prev.strokeWidth === strokeWidth) {
          return e;
        }
        return {
          ...e,
          animated: false,
          style: { ...prev, stroke, strokeWidth },
        };
      })
    );
  }, [statusKey, statuses, setEdges]);

  return (
    <div ref={wrapRef} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        onNodeClick={onNodeSelect ? (_, n) => onNodeSelect(n.id) : undefined}
        onPaneClick={onNodeSelect ? () => onNodeSelect(null) : undefined}
        onNodesChange={onNodesChangeWithRelayout}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        minZoom={0.4}
        maxZoom={1.5}
        // On touch, don't swallow the page scroll, the graph is pan-by-drag and the
        // page scrolls past it, so a phone user isn't trapped on the canvas. (The
        // graph is a secondary view on mobile; the text timeline carries the detail.)
        preventScrolling={false}
      >
        <Background gap={18} size={1.5} color="#D7DAE1" />
      </ReactFlow>
    </div>
  );
};

/** Public props. `onNodeSelect` (+ `selectedId`) makes the graph INTERACTIVE: a node
    click reports its id, a pane click clears it, and the selected node gets a halo.
    Omitted (pipeline run, diff preview) → clicks are inert, exactly as before. */
type WorkflowGraphProps = {
  workflow: ApprovalWorkflow;
  statuses?: StepStatuses;
  changes?: StepChange[];
  issues?: WorkflowIssue[];
  onNodeSelect?: (stepId: string | null) => void;
  selectedId?: string | null;
  /** Gates the run is waiting on, with their staged choice, renders inline
      Approve / Reject on those nodes. Omitted everywhere except a paused run. */
  decisions?: Record<string, "approve" | "reject" | null>;
  /** When set, a node here accepts a decision now (a paused gate). */
  decidableIds?: string[];
  /** Staged reject notes per step id (shown on a node staged "reject"). */
  reasons?: Record<string, string>;
  /** Record a per-gate decision (the inline node controls). */
  onDecide?: (stepId: string, choice: "approve" | "reject") => void;
  /** Record a per-gate reject note (the inline node reason input). */
  onReason?: (stepId: string, reason: string) => void;
  /** The AI investigator's call for THIS run, shown on the paused gate(s) so the human
      sees what the agent concluded (verdict + reasoning on hover) right where they
      decide. Null when there's no investigation (a clean run) or not paused. */
  recommendation?: {
    verdict: "likely_legitimate" | "likely_overcharge" | "unclear";
    rationale: string | null;
  } | null;
  /** Smoothly pan/zoom to frame these nodes (the pending group, or one on hover). */
  focusIds?: string[];
};

export const WorkflowGraph = (props: WorkflowGraphProps) => {
  return (
    <div className="h-full min-h-[320px] w-full">
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
    </div>
  );
};
