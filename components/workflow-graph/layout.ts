import { type Node, type Edge } from "@xyflow/react";
import dagre from "dagre";

import type { NodeData } from "@/components/workflow-graph/node-data";
import { statusTone } from "@/components/workflow-graph/visual-map";

/* ── layout ────────────────────────────────────────────────────────────────── */

// Card width is fixed (244px). Heights are VARIABLE (a 2-line title or a `when`
// chip makes a card taller), and guessing them is what threw the centering off,
// so we lay out with REAL measured heights (React Flow's ResizeObserver fills
// `node.measured.height`). `estimateHeight` is only the pre-measurement fallback
// for the very first paint, before measurements land.
const NODE_WIDTH = 244;
export const estimateHeight = (data: NodeData): number => {
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
export const layout = (
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

  // STRAIGHTEN LINEAR SEGMENTS. The handle sits at a node's cross-axis CENTER; nodes of
  // different heights get different centers, so a plain chain A→B→C (each a single
  // in/out) renders with a kinked connector even though it's one straight line. Walk
  // rank order and, for every straight segment (source has exactly one child, target
  // exactly one parent), snap the target's center onto the source's. This makes a
  // linear run perfectly colinear regardless of card heights (the ONE thing that made
  // edges kink), while leaving fan-out branches and joins (2+ in/out) untouched, since
  // they aren't straight segments. Deterministic: it depends only on the graph shape.
  for (const id of [...g.nodes()].sort((a, b) => rankOf(a) - rankOf(b))) {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length !== 1) continue; // source must fan out to exactly one node
    const kid = kids[0];
    if (kid === undefined) continue;
    if ((parentsOf.get(kid) ?? []).length !== 1) continue; // target: single parent
    cross.set(kid, cross.get(id) ?? crossOf(kid));
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
