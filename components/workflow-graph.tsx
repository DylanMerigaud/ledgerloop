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
import {
  type ApprovalWorkflow,
  type WorkflowStep,
  type StepChange,
  describeCondition,
} from "@/lib/approval-workflow";

/**
 * The approval workflow as a real flow canvas (React Flow), laid out left→right by
 * dagre. The category convention is a node-and-edge canvas; this is that, in the
 * app's own card style. Nodes are VARIABLE height (an approval card with an
 * approver + a condition is taller than a bare integration), so we let React Flow
 * MEASURE each node first, then run dagre with the real dimensions — no guessing,
 * clean spacing whatever the content.
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

const integrationGlyph = (kind: string): string =>
  kind === "netsuite"
    ? "NS"
    : kind === "slack"
      ? "#"
      : kind === "jira"
        ? "J"
        : "→";

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

  return (
    <div
      className={`w-60 rounded-xl bg-surface px-3 py-2.5 shadow-card ring-1 ring-inset ${changeRing(
        change,
      )} ${change === "removed" ? "opacity-60 line-through" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-1.5 !border-0 !bg-line-strong"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
          {isApproval ? (
            <span className="grid size-5 place-items-center rounded-full bg-subtle text-[10px] text-muted ring-1 ring-inset ring-line-strong">
              ✓
            </span>
          ) : (
            <span className="grid size-5 place-items-center rounded-full bg-accent/10 text-[9px] font-semibold text-accent ring-1 ring-inset ring-accent/20">
              {integrationGlyph((step as { integration: string }).integration)}
            </span>
          )}
          {step.label}
        </span>
        {cb ? (
          <Badge tone={cb.tone}>{cb.label}</Badge>
        ) : (
          st && <Badge tone={st.tone}>{st.label}</Badge>
        )}
      </div>

      {isApproval && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-7 text-[11px]">
          {step.approverName ? (
            <>
              <span className="grid size-4 place-items-center rounded-full bg-accent/15 text-[8px] font-semibold uppercase text-accent">
                {step.approverName
                  .split(" ")
                  .map((p) => p[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <span className="text-muted">
                {step.approverName}{" "}
                <span className="text-muted/70">· {step.approverTitle}</span>
              </span>
            </>
          ) : (
            <span className="font-medium text-warn">
              ⚠ unresolved — {step.approverTitle}
            </span>
          )}
        </div>
      )}

      {!unconditional && (
        <div className="mt-1.5 pl-7">
          <span className="rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-inset ring-line-strong">
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

// Fixed node box for layout. Width is fixed (`w-60` = 240px). Height is derived
// DETERMINISTICALLY from the card's content (no measurement round-trip — that
// timing was unreliable in React Flow): a header row, plus an approver row and/or
// a condition chip when present. Generous enough that dagre never overlaps.
const NODE_WIDTH = 240;
const nodeHeight = (step: WorkflowStep): number => {
  let h = 40; // header row + padding
  if (step.kind === "approval") h += 22; // approver / unresolved line
  if (step.when.kind !== "always") h += 24; // the `when …` chip
  return h;
};

/** Run dagre with deterministic node sizes; return positioned nodes (LR). */
const layout = (nodes: Node<NodeData>[], edges: Edge[]): Node<NodeData>[] => {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: nodeHeight(n.data.step) });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const node = g.node(n.id);
    // dagre gives the center; React Flow positions by top-left.
    return {
      ...n,
      position: { x: node.x - node.width / 2, y: node.y - node.height / 2 },
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
          animated: false,
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
