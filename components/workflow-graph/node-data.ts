import type { WorkflowStep, StepChange } from "@/lib/approval-workflow";

/** The data each React Flow node carries. */
export type NodeData = {
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
