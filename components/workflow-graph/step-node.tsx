import { Handle, type Node, type NodeProps, NodeToolbar, Position } from "@xyflow/react";

import type { NodeData } from "@/components/workflow-graph/node-data";

import { Badge } from "@/components/ui/badge";
import { GateButton } from "@/components/workflow-graph/gate-button";
import {
  changeBadge,
  changeRing,
  integrationBrand,
  issueRing,
  statusTone,
} from "@/components/workflow-graph/visual-map";
import { humanizeCondition } from "@/lib/approval-workflow";

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
  const isUnconditional = step.when.kind === "always";

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
  const dim = change === "removed" ? "opacity-60" : status === "skipped" ? "opacity-45" : "";

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

        {/* status / change badge on top, like the reference card. It can appear mid-run
            (a live run painting Approved/Done) and grow the card, the layout re-aligns
            on the new measured height, so the edge stays straight. */}
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
                    <span className="text-[12px] font-medium text-ink">{name}</span>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {!isUnconditional && (
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
            {/* The AI's take lives ON the button it suggests (a ✦ prefix), and hovering
                that button reveals the verdict + reasoning. `likely_legitimate` marks
                Approve, `likely_overcharge` marks Reject, `unclear` marks neither, so
                the recommendation reads as "the AI leans this way", not a 3rd control. */}
            <GateButton
              choiceKind="reject"
              label="Reject"
              testId={`gate-reject-${step.id}`}
              active={choice === "reject"}
              onClick={() => onDecide("reject")}
              recommendation={
                recommendation?.verdict === "likely_overcharge" ? recommendation : null
              }
            />
            <GateButton
              choiceKind="approve"
              label="Approve"
              testId={`gate-approve-${step.id}`}
              active={choice === "approve"}
              onClick={() => onDecide("approve")}
              recommendation={
                recommendation?.verdict === "likely_legitimate" ? recommendation : null
              }
            />
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

export const nodeTypes = { step: StepNode };
