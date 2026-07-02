"use client";

import {
  ReactFlow,
  Background,
  Handle,
  NodeToolbar,
  Position,
  useReactFlow,
  useNodesInitialized,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { SlackIcon, NetSuiteIcon, JiraIcon } from "@/components/ui/brand-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  type ApprovalWorkflow,
  type WorkflowStep,
  type StepChange,
  humanizeCondition,
} from "@/lib/approval-workflow";
import type { WorkflowIssue } from "@/lib/workflow-validate";

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

export type StepStatuses = Record<string, string>;

/** Target statuses that mean "the invoice reached this node", so the edge into it is
    on the realized path (skipped/blocked are dead branches, not part of the flow). */
const REACHED = new Set(["pending", "approved", "done", "rejected"]);

/* ── node visuals ──────────────────────────────────────────────────────────── */

const statusTone = (
  status: string | undefined,
): { tone: "ok" | "warn" | "danger" | "neutral"; label: string } | null => {
  switch (status) {
    case "approved":
      return { tone: "ok", label: "Approved" };
    case "done":
      return { tone: "ok", label: "Done" };
    case "pending":
      return { tone: "warn", label: "In review" };
    case "rejected":
      return { tone: "danger", label: "Rejected" };
    case "blocked":
      return { tone: "danger", label: "Blocked" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    default:
      return null;
  }
};

/** The real brand mark + display name for an integration kind. */
const integrationBrand = (
  kind: string,
): { Icon: (p: { size?: number }) => React.ReactNode; name: string } => {
  switch (kind) {
    case "slack":
      return { Icon: SlackIcon, name: "Slack" };
    case "netsuite":
      return { Icon: NetSuiteIcon, name: "NetSuite" };
    case "jira":
      return { Icon: JiraIcon, name: "Jira" };
    default:
      return { Icon: () => <span className="text-faint">→</span>, name: kind };
  }
};

const changeRing = (change: StepChange["kind"] | undefined): string => {
  switch (change) {
    case "added":
      return "ring-ok-line bg-ok-soft/30";
    case "changed":
      return "ring-warn-line bg-warn-soft/30";
    case "removed":
      return "ring-danger-line bg-danger-soft/30";
    default:
      return "ring-line";
  }
};

const changeBadge = (
  change: StepChange["kind"] | undefined,
): { tone: "ok" | "warn" | "danger"; label: string } | null => {
  if (change === "added") return { tone: "ok", label: "Added" };
  if (change === "changed") return { tone: "warn", label: "Changed" };
  if (change === "removed") return { tone: "danger", label: "Removed" };
  return null;
};

/** The data each React Flow node carries. */
type NodeData = {
  step: WorkflowStep;
  status?: string;
  change?: StepChange["kind"];
  /** A validation issue flagged on this step (rings it warn/danger). */
  issue?: "error" | "warning";
  /** Stacked top→bottom (narrow screens) instead of left→right, moves the edge
      handles to Top/Bottom so the connectors meet the cards correctly. */
  vertical?: boolean;
  /** Whether this node actually has an incoming / outgoing edge in the rendered
      graph. A leaf (the terminal "Post") has no outgoing handle; a root (the first
      gate) has no incoming handle, so we don't render a dangling connector stub. */
  hasIncoming?: boolean;
  hasOutgoing?: boolean;
  /** This node is the one selected for editing, gets an accent halo. */
  selected?: boolean;
  /** This pending gate accepts a human decision right now (run paused on it),
      renders inline Approve / Reject. */
  decidable?: boolean;
  /** The decision staged on this gate (before the reviewer submits the wave). */
  choice?: "approve" | "reject";
  /** The reject note staged on this gate (only when choice is "reject"). */
  reason?: string;
  /** Record the reviewer's choice for this gate. */
  onDecide?: (choice: "approve" | "reject") => void;
  /** Record the reviewer's reject note for this gate. */
  onReason?: (reason: string) => void;
  /** The AI investigator's call for this run (verdict + reasoning), shown in the gate
      toolbar so it informs the decision without opening the trace. */
  recommendation?: {
    verdict: "likely_legitimate" | "likely_overcharge" | "unclear";
    rationale: string | null;
  };
};

/** Ring/bg for a validation issue on a node (only used when there's no diff change). */
const issueRing = (sev: "error" | "warning" | undefined): string => {
  if (sev === "error") return "ring-danger-line bg-danger-soft/20";
  if (sev === "warning") return "ring-warn-line bg-warn-soft/20";
  return "ring-line";
};

/** The label + tone for the AI investigator's verdict. */
const VERDICT_META: Record<
  "likely_legitimate" | "likely_overcharge" | "unclear",
  { label: string; text: string; dot: string }
> = {
  likely_legitimate: {
    label: "Likely legitimate",
    text: "text-ok",
    dot: "bg-ok",
  },
  likely_overcharge: {
    label: "Likely overcharge",
    text: "text-danger",
    dot: "bg-danger",
  },
  unclear: { label: "Unclear", text: "text-warn", dot: "bg-warn" },
};

/** The AI investigator's call, a small spark button beside Approve; on hover it shows
    the verdict + the full reasoning. Tinted by the verdict so a glance already hints
    the direction, the detail is one hover away, no trace drawer needed. */
const RecommendationSpark = ({
  recommendation,
  stepId,
}: {
  recommendation: NonNullable<NodeData["recommendation"]>;
  stepId: string;
}) => {
  const meta = VERDICT_META[recommendation.verdict];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid={`gate-ai-${stepId}`}
            aria-label={`AI recommendation: ${meta.label}`}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[13px] ring-1 ring-inset ring-line transition-colors hover:bg-subtle ${meta.text}`}
          >
            <span aria-hidden>✦</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px]">
          <span className="flex items-center gap-1.5 font-medium">
            <span
              className={`inline-block size-1.5 rounded-full ${meta.dot}`}
            />
            AI: {meta.label}
          </span>
          {recommendation.rationale && (
            <span className="mt-1 block text-muted">
              {recommendation.rationale}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

/** A workflow step rendered as the app's card, used as a React Flow custom node. */
const StepNode = ({ data }: NodeProps<Node<NodeData>>) => {
  const {
    step,
    status,
    change,
    issue,
    vertical,
    hasIncoming,
    hasOutgoing,
    selected,
    decidable,
    choice,
    reason,
    onDecide,
    onReason,
    recommendation,
  } = data;
  const st = statusTone(status);
  const cb = changeBadge(change);
  const isApproval = step.kind === "approval";
  const condition = humanizeCondition(step.when);
  // Co-approvers beyond the primary (the panel's "Also requires").
  const extraApprovers = step.kind === "approval" ? (step.approvers ?? []) : [];
  const unconditional = step.when.kind === "always";

  const badge = cb ?? st;
  // A staged decision tints the whole card (so the canvas shows at a glance which
  // way each parallel gate is going); otherwise diff colours, then validation issue.
  const choiceRing =
    choice === "approve"
      ? "ring-ok-line bg-ok-soft/30"
      : choice === "reject"
        ? "ring-danger-line bg-danger-soft/30"
        : null;
  const ring = choiceRing ?? (change ? changeRing(change) : issueRing(issue));
  // Edges enter the top / leave the bottom when stacked vertically, the left / right
  // when laid out horizontally, so the connectors meet the right edge of each card.
  const targetPos = vertical ? Position.Top : Position.Left;
  const sourcePos = vertical ? Position.Bottom : Position.Right;

  // Selected (editing) → an accent halo that reads above the inset state/diff ring.
  const selectedRing = selected
    ? "ring-2 ring-accent ring-offset-2 ring-offset-subtle shadow-lift"
    : `ring-1 ring-inset ${ring}`;
  // A skipped gate didn't fire on this run, fade it so the realized path reads first
  // (kept in the graph, not hidden, so the audit shows every gate was considered).
  const dim =
    change === "removed"
      ? "opacity-60"
      : status === "skipped"
        ? "opacity-45"
        : "";

  return (
    <>
      <div
        data-testid={`graph-node-${step.id}`}
        className={`w-[244px] rounded-xl bg-surface px-3.5 py-3 shadow-card ${selectedRing} ${dim}`}
      >
        {/* Only render the incoming handle when a real edge feeds this node, so a
          root gate doesn't show a dangling connector stub. Default true when
          undefined (template views that don't compute connectivity). */}
        {hasIncoming !== false && (
          <Handle
            type="target"
            position={targetPos}
            className="!size-1.5 !border-0 !bg-line-strong"
          />
        )}

        {/* status / change badge on top, like the reference card */}
        {badge && (
          <div className="mb-1.5">
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
        )}

        {/* the step title */}
        <div
          className={`text-[13.5px] font-semibold leading-snug text-ink ${
            change === "removed" ? "line-through" : ""
          }`}
        >
          {step.label}
        </div>

        {/* the labeled detail block: Approver (person) or Integration (logo) */}
        {isApproval ? (
          <div className="mt-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
              Approver
            </div>
            {step.approverName ? (
              <>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="grid size-[18px] place-items-center rounded-full bg-accent-soft text-[8px] font-semibold uppercase text-accent">
                    {step.approverName
                      .split(" ")
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join("")}
                  </span>
                  <span className="truncate text-[12px] font-medium text-ink">
                    {step.approverName}
                  </span>
                  {extraApprovers.length > 0 && (
                    <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                      +{extraApprovers.length}
                    </span>
                  )}
                </div>
                {extraApprovers.length > 0 && (
                  <div className="mt-1 truncate text-[11px] font-medium text-faint">
                    with {extraApprovers.join(", ")}
                  </div>
                )}
              </>
            ) : (
              <div className="mt-1 text-[11.5px] font-medium text-warn">
                ⚠ unresolved · {step.approverTitle}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
              Integration
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              {(() => {
                const { Icon, name } = integrationBrand(step.integration);
                return (
                  <>
                    <Icon size={16} />
                    <span className="text-[12px] font-medium text-ink">
                      {name}
                    </span>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {!unconditional && (
          <div className="mt-2">
            {/* The trigger as a plain-English rule pill (not code/monospace). */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
              <span className="size-1 rounded-full bg-accent" aria-hidden />
              {condition}
            </span>
          </div>
        )}

        {/* Only render the outgoing handle when a real edge leaves this node, so the
          terminal "Post" node doesn't show a dangling connector stub. */}
        {hasOutgoing !== false && (
          <Handle
            type="source"
            position={sourcePos}
            className="!size-1.5 !border-0 !bg-line-strong"
          />
        )}
      </div>
      {/* Decision UI in a floating toolbar BELOW the node. Rendered as a SIBLING of the
          card (not a child), so React Flow measures the card's height alone, not the
          card + toolbar. When it was a child, the portaled toolbar inflated the node's
          measured height (~167px vs 56), which threw off the layout's centering and
          kinked the edges at the join. `nodrag nopan` so a click lands on the control
          instead of panning the canvas; the reject note (optional) rides into the audit. */}
      {decidable && onDecide && (
        <NodeToolbar
          isVisible
          position={Position.Bottom}
          className="nodrag nopan flex w-[244px] flex-col gap-1.5 rounded-xl bg-surface p-2 shadow-lift ring-1 ring-inset ring-line"
        >
          <div className="flex gap-1.5">
            <button
              type="button"
              data-testid={`gate-reject-${step.id}`}
              onClick={() => onDecide("reject")}
              className={`h-7 flex-1 rounded-lg text-[12px] font-medium ring-1 ring-inset transition-colors ${
                choice === "reject"
                  ? "bg-danger text-white ring-transparent"
                  : "bg-surface text-danger ring-danger-line hover:bg-danger-soft"
              }`}
            >
              Reject
            </button>
            <button
              type="button"
              data-testid={`gate-approve-${step.id}`}
              onClick={() => onDecide("approve")}
              className={`h-7 flex-1 rounded-lg text-[12px] font-medium ring-1 ring-inset transition-colors ${
                choice === "approve"
                  ? "bg-ok text-white ring-transparent"
                  : "bg-surface text-ok ring-ok-line hover:bg-ok-soft"
              }`}
            >
              Approve
            </button>
            {/* The AI investigator's take, a spark to the right of Approve; hover
                reveals the verdict + reasoning. Quiet by default so it informs the
                decision without shouting over the buttons. */}
            {recommendation && (
              <RecommendationSpark
                recommendation={recommendation}
                stepId={step.id}
              />
            )}
          </div>
          {onReason && choice === "reject" && (
            <input
              value={reason ?? ""}
              onChange={(e) => onReason(e.target.value)}
              placeholder="Reason (optional)"
              data-testid={`gate-reason-${step.id}`}
              className="h-7 w-full rounded-lg bg-surface px-2 text-[12px] text-ink outline-none ring-1 ring-inset ring-danger-line transition-shadow focus:ring-2 focus:ring-accent-ring"
            />
          )}
        </NodeToolbar>
      )}
    </>
  );
};

const nodeTypes = { step: StepNode };

/* ── layout ────────────────────────────────────────────────────────────────── */

// Card width is fixed (244px). Heights are VARIABLE (a 2-line title or a `when`
// chip makes a card taller), and guessing them is what threw the centering off,
// so we lay out with REAL measured heights (React Flow's ResizeObserver fills
// `node.measured.height`). `estimateHeight` is only the pre-measurement fallback
// for the very first paint, before measurements land.
const NODE_WIDTH = 244;
const estimateHeight = (data: NodeData): number => {
  const hasBadge = data.change != null || statusTone(data.status) != null;
  let h = 24 + 20 + 24; // padding + title + detail block
  if (hasBadge) h += 24; // the status / change badge row + its margin
  if (data.step.when.kind !== "always") h += 26; // the `when …` chip
  return h;
};

const NODE_SEP = 40; // vertical gap between siblings
const RANK_SEP = 110; // horizontal gap between columns (generous, Pivot-like)

/**
 * Lay out the graph LR with dagre using REAL measured heights, then a centering pass
 * that sits each parent on the vertical MIDDLE of its children's bounding box (top of
 * the topmost child to bottom of the bottommost) and each join node on its parents'
 * box. dagre's `tight-tree` alone centers on the barycenter, which drifts when
 * siblings have different heights (a tall 2-line `Director` card vs a short one),
 * bounding-box centering with the true heights is what makes the parent sit dead
 * center, the Pivot look.
 */
const layout = (
  nodes: Node<NodeData>[],
  edges: Edge[],
  heightOf: (n: Node<NodeData>) => number,
  vertical: boolean,
): Node<NodeData>[] => {
  const h = new Map(nodes.map((n) => [n.id, heightOf(n)]));
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    // Horizontal (LR) on desktop; vertical (TB) on a narrow screen, where a wide
    // left-to-right DAG can't fit, stacked, each node gets the full column width.
    rankdir: vertical ? "TB" : "LR",
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    ranker: "tight-tree",
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: h.get(n.id) ?? 80 });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  // The CROSS axis is the one a parent is centered on, across its children: the
  // vertical axis when ranks flow left→right, the horizontal axis when top→bottom.
  // `rank` is the other axis (which column/row). We center + reorder on the cross
  // axis, so the same logic serves both orientations by swapping which coord it reads.
  const crossOf = (id: string): number =>
    vertical ? g.node(id).x : g.node(id).y;
  const crossSizeOf = (id: string): number =>
    vertical ? NODE_WIDTH : (h.get(id) ?? 80);

  const cross = new Map<string, number>(); // node id → center on the cross axis
  for (const id of g.nodes()) cross.set(id, crossOf(id));
  const halfOf = (id: string): number => crossSizeOf(id) / 2;
  const boxMid = (ids: string[]): number => {
    const tops = ids.map((k) => (cross.get(k) ?? 0) - halfOf(k));
    const bots = ids.map((k) => (cross.get(k) ?? 0) + halfOf(k));
    return (Math.min(...tops) + Math.max(...bots)) / 2;
  };

  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    childrenOf.set(e.source, [...(childrenOf.get(e.source) ?? []), e.target]);
    parentsOf.set(e.target, [...(parentsOf.get(e.target) ?? []), e.source]);
  }

  // SIBLING ORDER (along the cross axis) follows the parent's `next` order, NOT
  // dagre's crossing-minimisation (which can reshuffle). We keep the exact slots
  // dagre computed for a parent's children (so spacing + measured sizes are
  // respected), but RE-ASSIGN those slots to the children in `next` order. Only for
  // siblings that belong to a single parent (true fan-out branches), a shared join
  // node like the post isn't reordered.
  for (const [, children] of childrenOf) {
    const branches = children.filter(
      (c) => (parentsOf.get(c) ?? []).length === 1,
    );
    if (branches.length < 2) continue;
    const slots = branches.map((c) => cross.get(c) ?? 0).sort((a, b) => a - b);
    branches.forEach((c, i) => cross.set(c, slots[i] ?? cross.get(c) ?? 0));
  }

  // Parents centered on their children (deepest rank first so children settle first).
  const rankOf = (id: string): number =>
    vertical ? g.node(id).y : g.node(id).x;
  for (const id of [...g.nodes()].sort((a, b) => rankOf(b) - rankOf(a))) {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length >= 2) cross.set(id, boxMid(kids));
  }
  // Join nodes centered on their parents (shallowest rank first).
  for (const id of [...g.nodes()].sort((a, b) => rankOf(a) - rankOf(b))) {
    const parents = parentsOf.get(id) ?? [];
    if (parents.length >= 2) cross.set(id, boxMid(parents));
  }

  return nodes.map((n) => {
    const node = g.node(n.id);
    const c = cross.get(n.id) ?? crossOf(n.id);
    // dagre gives the center; React Flow positions by top-left. Map the cross-axis
    // center back to x (vertical) or y (horizontal); the rank axis is dagre's own.
    const x = vertical ? c - NODE_WIDTH / 2 : node.x - node.width / 2;
    const y = vertical ? node.y - node.height / 2 : c - halfOf(n.id);
    return { ...n, position: { x, y } };
  });
};

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
  const vertical = useMediaQuery("(max-width: 639px)");

  const changeOf = useMemo(
    () => new Map((changes ?? []).map((c) => [c.id, c.kind])),
    [changes],
  );

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
  const removed = useMemo(
    () => (changes ?? []).filter((c) => c.kind === "removed"),
    [changes],
  );

  const initialNodes = useMemo<Node<NodeData>[]>(() => {
    // Connectivity from the rendered node set: a node HAS an incoming edge if some
    // present step lists it in `next`; HAS an outgoing edge if its own `next` points
    // at a present node. Used to drop the dangling handle on roots (no incoming) and
    // leaves like the terminal Post (no outgoing).
    const present = new Set(workflow.steps.map((s) => s.id));
    const targets = new Set<string>();
    for (const s of workflow.steps)
      for (const n of s.next) if (present.has(n)) targets.add(n);

    const real = workflow.steps.map((step) => ({
      id: step.id,
      type: "step",
      position: { x: 0, y: 0 },
      data: {
        step,
        status: statuses?.[step.id],
        change: changeOf.get(step.id),
        issue: issueOf.get(step.id),
        vertical,
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
        vertical,
      },
    }));
    return [...real, ...gone];
  }, [workflow, statuses, changeOf, removed, issueOf, vertical]);

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
    initialNodes.map((n) => ({ ...n, style: { visibility: "hidden" } })),
  );
  const [rfEdges, setEdges, onEdgesChange] = useEdgesState<Edge>(edges);
  // Bumped to force one more layout pass when a node's measured height drifts after the
  // initial layout (see the drift effect below); a dep of the layout effect.
  const [relayoutTick, setRelayoutTick] = useState(0);

  // True once every current node has been measured. Resets when the set changes.
  const initialized = useNodesInitialized();

  // When the source graph changes (new discovery / edit), reset to the new nodes
  // HIDDEN so they get re-measured, and mark that this set still needs a layout.
  const laidOutFor = useRef<string>("");
  // The measured heights the current layout was computed from, so a later drift (a
  // few-px settle) can be detected and corrected with a single re-layout.
  const laidOutHeights = useRef<Map<string, number | null>>(new Map());
  // The graph's container, observed so we can re-fit when it resizes (the editor's
  // bottom stack growing/shrinking, a window resize). fitView otherwise runs once per
  // graph, so without this a node could sit clipped off the edge after a resize.
  const wrapRef = useRef<HTMLDivElement>(null);
  const graphKey = useMemo(
    () =>
      initialNodes.map((n) => n.id).join("|") +
      "::" +
      edges.length +
      (vertical ? "::v" : "::h"),
    [initialNodes, edges, vertical],
  );
  useEffect(() => {
    setNodes(
      initialNodes.map((n) => ({ ...n, style: { visibility: "hidden" } })),
    );
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
    if (!initialized || laidOutFor.current === graphKey) return;
    laidOutFor.current = graphKey;
    setNodes((cur) => {
      const measured = new Map(cur.map((n) => [n.id, n.measured?.height]));
      // Remember the heights this layout is based on. If a node's measured height
      // later drifts (a badge/font/when-chip settling a few px after the one-shot
      // layout), the re-layout effect below notices and lays out again, so the node
      // centers, and therefore the edge handles, don't end up a few px off (which a
      // smoothstep edge renders as a visible stair-step "kink").
      laidOutHeights.current = new Map(
        cur.map((n) => [n.id, n.measured?.height ?? null]),
      );
      return layout(
        initialNodes,
        edges,
        (n) => measured.get(n.id) ?? estimateHeight(n.data),
        vertical,
      ).map((n) => ({ ...n, style: { visibility: "visible" } }));
    });
    const focus = focusIds ?? [];
    requestAnimationFrame(
      () =>
        void fitView(
          focus.length > 0
            ? {
                nodes: focus.map((id) => ({ id })),
                padding: 0.25,
                maxZoom: 1.1,
                duration: 200,
              }
            : { padding: 0.18, duration: 200 },
        ),
    );
  }, [
    initialized,
    graphKey,
    initialNodes,
    edges,
    setNodes,
    fitView,
    vertical,
    focusIds,
    relayoutTick,
  ]);

  // Correct post-layout height DRIFT. React Flow keeps re-measuring nodes; if one's
  // height settles a few px AFTER the one-shot layout (a badge/font/when-chip), the
  // node centers computed from the old heights are now slightly wrong, and the edge
  // handles sit a few px apart, which a smoothstep edge draws as a stair-step kink.
  // Detect any drift > 1px from the heights the layout used, then force one re-layout
  // (reset the guard + bump the tick). Bounded: after the re-layout the heights match,
  // so it settles and can't loop.
  const drifted =
    initialized &&
    laidOutFor.current === graphKey &&
    nodes.some((n) => {
      const used = laidOutHeights.current.get(n.id);
      const now = n.measured?.height;
      return used != null && now != null && Math.abs(used - now) > 1;
    });
  useEffect(() => {
    if (!drifted) return;
    laidOutFor.current = "";
    setRelayoutTick((t) => t + 1);
  }, [drifted, graphKey]);

  // Re-fit when the container resizes so nodes never sit clipped past an edge after a
  // layout reflow or window resize. RAF-debounced; skipped until the nodes exist.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!initialized) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void fitView({ padding: 0.18 }));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [initialized, fitView]);

  // Patch the `selected` halo on the live nodes when the selection changes, cheap,
  // no re-layout (kept out of the layout pipeline so a click doesn't reflow the graph).
  useEffect(() => {
    setNodes((cur) =>
      cur.map((n) =>
        n.data.selected === (n.id === selectedId)
          ? n
          : { ...n, data: { ...n.data, selected: n.id === selectedId } },
      ),
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
    const decidable = new Set(decidableIds ?? []);
    setNodes((cur) =>
      cur.map((n) => {
        const isDecidable = decidable.has(n.id);
        const choice = decisions?.[n.id] ?? undefined;
        const reason = reasons?.[n.id] ?? undefined;
        const handler =
          isDecidable && onDecide
            ? (c: "approve" | "reject") => onDecide(n.id, c)
            : undefined;
        const reasonHandler =
          isDecidable && onReason
            ? (r: string) => onReason(n.id, r)
            : undefined;
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
      }),
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

  // Smoothly frame the focused nodes (the pending group awaiting a decision, or one on
  // hover), so the node you must act on lands centered. Runs after the per-graph layout
  // (`laidOutFor === graphKey`) so it doesn't fight the one-shot fit; keyed on `focusKey`
  // so it animates once per change (the next gate after an approve re-centers here).
  // `maxZoom` lets it actually zoom IN on a single gate (fitView otherwise caps the
  // zoom and, on a 2-node graph, would just frame both and leave the gate off-center);
  // a rAF lets the just-laid-out node measurements settle before we measure their box.
  const focusKey = (focusIds ?? []).join("|");
  useEffect(() => {
    if (!initialized || laidOutFor.current !== graphKey || focusKey === "")
      return;
    const ids = focusKey.split("|").map((id) => ({ id }));
    // Frame the pending gate itself, tightly. A large padding made fitView zoom out
    // until the WHOLE graph fit (the gate no longer looked focused); a small padding
    // keeps the gate centered and legible. maxZoom caps how far it zooms in on a lone
    // node so it doesn't blow up. A rAF lets the just-laid-out measurements settle.
    const raf = requestAnimationFrame(
      () =>
        void fitView({
          nodes: ids,
          duration: 400,
          padding: 0.25,
          maxZoom: 1.1,
        }),
    );
    return () => cancelAnimationFrame(raf);
  }, [focusKey, initialized, graphKey, fitView]);

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
        const live =
          (src === "approved" || src === "done") &&
          REACHED.has(st[e.target] ?? "");
        const stroke = live ? "#5B53D6" : "#CBCDD4";
        const strokeWidth = live ? 2 : 1.5;
        const prev = e.style ?? {};
        if (
          e.animated === live &&
          prev.stroke === stroke &&
          prev.strokeWidth === strokeWidth
        ) {
          return e;
        }
        return {
          ...e,
          animated: live,
          style: { ...prev, stroke, strokeWidth },
        };
      }),
    );
  }, [statusKey, statuses, setEdges]);

  return (
    <div ref={wrapRef} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        onNodeClick={onNodeSelect ? (_, n) => onNodeSelect(n.id) : undefined}
        onPaneClick={onNodeSelect ? () => onNodeSelect(null) : undefined}
        onNodesChange={onNodesChange}
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
