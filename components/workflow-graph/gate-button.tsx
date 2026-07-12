import type { NodeData } from "@/components/workflow-graph/node-data";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { VERDICT_META } from "@/components/workflow-graph/visual-map";

/** A gate decision button (Reject / Approve). When it carries the AI recommendation it
    wears a ✦ prefix and, on hover, a tooltip with the verdict + reasoning, so the AI's
    suggested action IS the button (not a separate control beside it). */
export const GateButton = ({
  choiceKind,
  label,
  testId,
  active,
  onClick,
  recommendation,
}: {
  choiceKind: "approve" | "reject";
  label: string;
  testId: string;
  active: boolean;
  onClick: () => void;
  recommendation: NonNullable<NodeData["recommendation"]> | null;
}) => {
  const tone =
    choiceKind === "approve"
      ? active
        ? "bg-ok text-white ring-transparent"
        : "bg-surface text-ok ring-ok-line hover:bg-ok-soft"
      : active
        ? "bg-danger text-white ring-transparent"
        : "bg-surface text-danger ring-danger-line hover:bg-danger-soft";
  const btn = (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-lg text-[12px] font-medium ring-1 ring-inset transition-colors ${tone}`}
    >
      {recommendation && (
        <span aria-hidden className="text-[13px]">
          ✦
        </span>
      )}
      {label}
    </button>
  );
  if (!recommendation) return btn;
  const meta = VERDICT_META[recommendation.verdict];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px]">
          <span className="flex items-center gap-1.5 font-medium">
            <span className={`inline-block size-1.5 rounded-full ${meta.dot}`} />
            AI: {meta.label}
          </span>
          {recommendation.rationale && (
            <span className="mt-1 block text-muted">{recommendation.rationale}</span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
