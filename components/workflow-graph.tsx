"use client";

import {
  ReactFlow,
  Background,
  Handle,
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
import { useEffect, useMemo, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { SlackIcon, NetSuiteIcon, JiraIcon } from "@/components/ui/brand-icon";
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
 * card, then run dagre with the real heights and reveal — the measured pattern from
 * reactflow-auto-layout. Wiring `onNodesChange` (via useNodesState) is what lets the
 * measurements flow back so `useNodesInitialized` flips and the layout runs.
 *
 * The same component renders three things off one workflow: the derived workflow
 * (onboarding), a proposed edit (diff colours via `changes`), and a live run
 * (per-step status colours via `statuses`).
 */

export type StepStatuses = Record<string, string>;

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
  /** Stacked top→bottom (narrow screens) instead of left→right — moves the edge
      handles to Top/Bottom so the connectors meet the cards correctly. */
  vertical?: boolean;
  /** This node is the one selected for editing — gets an accent halo. */
  selected?: boolean;
};

/** Ring/bg for a validation issue on a node (only used when there's no diff change). */
const issueRing = (sev: "error" | "warning" | undefined): string => {
  if (sev === "error") return "ring-danger-line bg-danger-soft/20";
  if (sev === "warning") return "ring-warn-line bg-warn-soft/20";
  return "ring-line";
};

/** A workflow step rendered as the app's card — used as a React Flow custom node. */
const StepNode = ({ data }: NodeProps<Node<NodeData>>) => {
  const { step, status, change, issue, vertical, selected } = data;
  const st = statusTone(status);
  const cb = changeBadge(change);
  const isApproval = step.kind === "approval";
  const condition = humanizeCondition(step.when);
  const unconditional = step.when.kind === "always";

  const badge = cb ?? st;
  // Diff colours take precedence (when previewing an edit); otherwise show any
  // validation issue ring.
  const ring = change ? changeRing(change) : issueRing(issue);
  // Edges enter the top / leave the bottom when stacked vertically, the left / right
  // when laid out horizontally — so the connectors meet the right edge of each card.
  const targetPos = vertical ? Position.Top : Position.Left;
  const sourcePos = vertical ? Position.Bottom : Position.Right;

  // Selected (editing) → an accent halo that reads above the inset state/diff ring.
  const selectedRing = selected
    ? "ring-2 ring-accent ring-offset-2 ring-offset-subtle shadow-lift"
    : `ring-1 ring-inset ${ring}`;

  return (
    <div
      data-testid={`graph-node-${step.id}`}
      className={`w-[244px] rounded-xl bg-surface px-3.5 py-3 shadow-card ${selectedRing} ${change === "removed" ? "opacity-60" : ""}`}
    >
      <Handle
        type="target"
        position={targetPos}
        className="!size-1.5 !border-0 !bg-line-strong"
      />

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
            </div>
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
      <Handle
        type="source"
        position={sourcePos}
        className="!size-1.5 !border-0 !bg-line-strong"
      />
    </div>
  );
};

const nodeTypes = { step: StepNode };

/* ── layout ────────────────────────────────────────────────────────────────── */

// Card width is fixed (244px). Heights are VARIABLE (a 2-line title or a `when`
// chip makes a card taller), and guessing them is what threw the centering off —
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
 * siblings have different heights (a tall 2-line `Director` card vs a short one) —
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
    // left-to-right DAG can't fit — stacked, each node gets the full column width.
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
  // siblings that belong to a single parent (true fan-out branches) — a shared join
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
}: WorkflowGraphProps) => {
  // Stack the DAG vertically below the `sm` breakpoint (640px), where a wide
  // left→right layout can't fit — each node then gets the full column width.
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

  // Removed steps aren't in `steps` — synthesize a node from the diff so the
  // preview shows what's going away.
  const removed = useMemo(
    () => (changes ?? []).filter((c) => c.kind === "removed"),
    [changes],
  );

  const initialNodes = useMemo<Node<NodeData>[]>(() => {
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

  // Controlled node/edge state with React Flow's own reducers — this wires
  // `onNodesChange`, so the ResizeObserver's measurements flow back into the store
  // and `useNodesInitialized` actually flips to true (without onNodesChange it
  // never does, and the layout never runs). Nodes start HIDDEN at 0,0.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>(
    initialNodes.map((n) => ({ ...n, style: { visibility: "hidden" } })),
  );
  const [rfEdges, setEdges, onEdgesChange] = useEdgesState<Edge>(edges);

  // True once every current node has been measured. Resets when the set changes.
  const initialized = useNodesInitialized();

  // When the source graph changes (new discovery / edit), reset to the new nodes
  // HIDDEN so they get re-measured, and mark that this set still needs a layout.
  const laidOutFor = useRef<string>("");
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
  // re-enter, since the key is already marked done).
  useEffect(() => {
    if (!initialized || laidOutFor.current === graphKey) return;
    laidOutFor.current = graphKey;
    setNodes((cur) => {
      const measured = new Map(cur.map((n) => [n.id, n.measured?.height]));
      return layout(
        initialNodes,
        edges,
        (n) => measured.get(n.id) ?? estimateHeight(n.data),
        vertical,
      ).map((n) => ({ ...n, style: { visibility: "visible" } }));
    });
    requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 200 }));
  }, [initialized, graphKey, initialNodes, edges, setNodes, fitView, vertical]);

  // Patch the `selected` halo on the live nodes when the selection changes — cheap,
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

  return (
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
      // On touch, don't swallow the page scroll — the graph is pan-by-drag and the
      // page scrolls past it, so a phone user isn't trapped on the canvas. (The
      // graph is a secondary view on mobile; the text timeline carries the detail.)
      preventScrolling={false}
    >
      <Background gap={18} size={1.5} color="#D7DAE1" />
    </ReactFlow>
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
