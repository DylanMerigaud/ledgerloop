import type { ApprovalWorkflow as TApprovalWorkflow } from "@/lib/approval-workflow";

/**
 * "Running against: <workflow>", the line that makes the link to onboarding
 * visible: the pipeline routes every invoice through this exact workflow. Shows
 * the active workflow's name once discovery/edits have produced one; otherwise a
 * quiet note that the default DAG is in use until the user derives theirs.
 */
export const RunningAgainst = ({
  workflow,
  onBuildWorkflow,
}: {
  workflow: TApprovalWorkflow | null;
  /** Jump back to the "Build the workflow" tab to run discovery. */
  onBuildWorkflow: () => void;
}) => {
  if (!workflow) {
    return (
      <p className="mt-1 text-[11px] text-faint">
        Default workflow.{" "}
        <button
          type="button"
          onClick={onBuildWorkflow}
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Build your own
        </button>{" "}
        to route against it.
      </p>
    );
  }
  return (
    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
      <span aria-hidden className="text-faint">
        ↳
      </span>
      Running against{" "}
      <span className="truncate font-medium text-ink">{workflow.name}</span>
    </p>
  );
};
