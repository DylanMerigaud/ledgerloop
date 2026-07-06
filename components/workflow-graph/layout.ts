import type { NodeData } from "@/components/workflow-graph/node-data";
import { statusTone } from "@/components/workflow-graph/visual-map";

/* ── height estimate ─────────────────────────────────────────────────────────── */

// Cards are a fixed 244px wide. Heights are VARIABLE (a 2-line title or a `when`
// chip makes a card taller), and guessing them is what throws centering off, so the
// graph lays out with REAL measured heights (React Flow's ResizeObserver fills
// `node.measured.height`). `estimateHeight` is only the pre-measurement fallback for
// the very first paint, before measurements land. The layout itself now comes from
// the `react-flow-auto-layout` package.
export const estimateHeight = (data: NodeData): number => {
  const hasBadge = data.change != null || statusTone(data.status) != null;
  let h = 24 + 20 + 24; // padding + title + detail block
  if (hasBadge) h += 24; // the status / change badge row + its margin
  if (data.step.when.kind !== "always") h += 26; // the `when …` chip
  return h;
};
