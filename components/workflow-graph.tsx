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
import {
  type ApprovalWorkflow,
  type WorkflowStep,
  type StepChange,
  describeCondition,
} from "@/lib/approval-workflow";

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
};

/** A workflow step rendered as the app's card — used as a React Flow custom node. */
const StepNode = ({ data }: NodeProps<Node<NodeData>>) => {
  const { step, status, change } = data;
  const st = statusTone(status);
  const cb = changeBadge(change);
  const isApproval = step.kind === "approval";
  const condition = describeCondition(step.when);
  const unconditional = step.when.kind === "always";

  const badge = cb ?? st;

  return (
    <div
      className={`w-[244px] rounded-xl bg-surface px-3.5 py-3 shadow-card ring-1 ring-inset ${changeRing(
        change,
      )} ${change === "removed" ? "opacity-60" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
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
          <span className="inline-block rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-inset ring-line-strong">
            when {condition}
          </span>
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
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
): Node<NodeData>[] => {
  const h = new Map(nodes.map((n) => [n.id, heightOf(n)]));
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
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

  const cy = new Map<string, number>(); // node id → center Y
  for (const id of g.nodes()) cy.set(id, g.node(id).y);
  const halfOf = (id: string): number => (h.get(id) ?? 80) / 2;
  const boxMid = (ids: string[]): number => {
    const tops = ids.map((k) => (cy.get(k) ?? 0) - halfOf(k));
    const bots = ids.map((k) => (cy.get(k) ?? 0) + halfOf(k));
    return (Math.min(...tops) + Math.max(...bots)) / 2;
  };

  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    childrenOf.set(e.source, [...(childrenOf.get(e.source) ?? []), e.target]);
    parentsOf.set(e.target, [...(parentsOf.get(e.target) ?? []), e.source]);
  }
  // Parents centered on their children (right→left so children settle first).
  for (const id of [...g.nodes()].sort((a, b) => g.node(b).x - g.node(a).x)) {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length >= 2) cy.set(id, boxMid(kids));
  }
  // Join nodes centered on their parents (left→right).
  for (const id of [...g.nodes()].sort((a, b) => g.node(a).x - g.node(b).x)) {
    const parents = parentsOf.get(id) ?? [];
    if (parents.length >= 2) cy.set(id, boxMid(parents));
  }

  return nodes.map((n) => {
    const node = g.node(n.id);
    const centerY = cy.get(n.id) ?? node.y;
    // dagre gives the center; React Flow positions by top-left.
    return {
      ...n,
      position: { x: node.x - node.width / 2, y: centerY - halfOf(n.id) },
    };
  });
};

/* ── the graph ─────────────────────────────────────────────────────────────── */

const Inner = ({
  workflow,
  statuses,
  changes,
}: {
  workflow: ApprovalWorkflow;
  statuses?: StepStatuses;
  changes?: StepChange[];
}) => {
  const changeOf = useMemo(
    () => new Map((changes ?? []).map((c) => [c.id, c.kind])),
    [changes],
  );

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
      },
    }));
    return [...real, ...gone];
  }, [workflow, statuses, changeOf, removed]);

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
    () => initialNodes.map((n) => n.id).join("|") + "::" + edges.length,
    [initialNodes, edges],
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
      ).map((n) => ({ ...n, style: { visibility: "visible" } }));
    });
    requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 200 }));
  }, [initialized, graphKey, initialNodes, edges, setNodes, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      minZoom={0.4}
      maxZoom={1.5}
    >
      <Background gap={18} size={1.5} color="#D7DAE1" />
    </ReactFlow>
  );
};

export const WorkflowGraph = (props: {
  workflow: ApprovalWorkflow;
  statuses?: StepStatuses;
  changes?: StepChange[];
}) => {
  return (
    <div className="h-full min-h-[320px] w-full">
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
    </div>
  );
};
