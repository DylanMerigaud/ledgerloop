"use client";

import {
  ReactFlow,
  Background,
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { useEffect, useMemo } from "react";

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
 * app's own card style. Nodes are VARIABLE height (a conditional approval card is
 * taller than a bare integration), so we derive each node's height DETERMINISTICALLY
 * from its content (`nodeHeight`) and feed dagre real sizes — React Flow's measure
 * round-trip fired too late to lay out on first paint, so we don't rely on it.
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

// Fixed node box for layout. Width matches the card (244px). Height is derived
// DETERMINISTICALLY from the card's content (no measurement round-trip — that
// timing was unreliable in React Flow): badge + title + a labelled detail block,
// plus the `when …` chip when conditional. dagre centers children on the parent's
// vertical midline (LR), so accurate heights = clean Y-centering, no overlap.
const NODE_WIDTH = 244;
const nodeHeight = (data: NodeData): number => {
  const hasBadge = data.change != null || statusTone(data.status) != null;
  let h = 24 + 20 + 24; // padding + title + detail block
  if (hasBadge) h += 24; // the status / change badge row + its margin
  if (data.step.when.kind !== "always") h += 26; // the `when …` chip
  return h;
};

/** Run dagre with deterministic node sizes; return positioned nodes (LR). */
const layout = (nodes: Node<NodeData>[], edges: Edge[]): Node<NodeData>[] => {
  const g = new dagre.graphlib.Graph();
  // nodesep = vertical gap between siblings (LR); ranksep = horizontal gap
  // between columns. No `align` — default dagre centers each node on the midline
  // of its neighbours, which is the balanced look we want (parent centered on its
  // children, the post centered on its approvers).
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 96 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: nodeHeight(n.data) });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  // dagre places a node at the BARYCENTER of its neighbours, which for a fan-out /
  // fan-in (one parent → N children → one post) doesn't sit the parent on the
  // vertical MIDDLE of its children. Re-center every node that has a single column
  // of children on the midpoint of those children's span — the balanced look in the
  // reference. Process right-to-left so children are settled before their parent.
  const cy = new Map<string, number>(); // node id → center Y
  for (const id of g.nodes()) cy.set(id, g.node(id).y);
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = childrenOf.get(e.source) ?? [];
    list.push(e.target);
    childrenOf.set(e.source, list);
  }
  const byX = [...g.nodes()].sort((a, b) => g.node(b).x - g.node(a).x); // right→left
  for (const id of byX) {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length < 2) continue; // a 1-child node already lines up with its child
    const tops = kids.map((k) => cy.get(k) ?? g.node(k).y);
    cy.set(id, (Math.min(...tops) + Math.max(...tops)) / 2);
  }
  // The post column has many parents and one node — center it on its parents too.
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    const list = parentsOf.get(e.target) ?? [];
    list.push(e.source);
    parentsOf.set(e.target, list);
  }
  for (const id of [...g.nodes()].sort((a, b) => g.node(a).x - g.node(b).x)) {
    const parents = parentsOf.get(id) ?? [];
    if (parents.length < 2) continue;
    const ys = parents.map((p) => cy.get(p) ?? g.node(p).y);
    cy.set(id, (Math.min(...ys) + Math.max(...ys)) / 2);
  }

  return nodes.map((n) => {
    const node = g.node(n.id);
    const centerY = cy.get(n.id) ?? node.y;
    // dagre gives the center; React Flow positions by top-left.
    return {
      ...n,
      position: { x: node.x - node.width / 2, y: centerY - node.height / 2 },
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

  // Lay out deterministically (sizes derived from content) — no measurement round
  // trip, so positions are right on the first render.
  const laidOutNodes = useMemo(
    () => layout(initialNodes, edges),
    [initialNodes, edges],
  );
  const { fitView } = useReactFlow<Node<NodeData>>();

  // Fit the view whenever the laid-out graph changes (new discovery / proposal).
  useEffect(() => {
    requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 200 }));
  }, [laidOutNodes, fitView]);

  return (
    <ReactFlow
      nodes={laidOutNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
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
