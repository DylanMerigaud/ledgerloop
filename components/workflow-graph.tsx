import { Badge } from "@/components/ui/badge";
import type { ApprovalWorkflow, WorkflowStep } from "@/lib/approval-workflow";
import { describeCondition } from "@/lib/approval-workflow";

/**
 * Renders an approval workflow as a top-down flow with parallel branches.
 *
 * Deliberately NOT a free-floating drag canvas (that's every competitor's
 * signature — Ramp, Zip, Pivot). This reads top-to-bottom like the rest of the
 * app's execution trace: the root gate, then its fan-out branches laid side by
 * side as parallel lanes, rejoining at the final step. Each node is a compact
 * card in the product's own design language.
 *
 * The point this view makes that a hand-built canvas can't: every approver was
 * RESOLVED from the org by the agent (or flagged unresolved for a human). An
 * optional `statuses` map colours each node by its live execution state, so the
 * same component renders both the derived workflow (onboarding) and a running
 * invoice's path through it.
 */

/** Per-step execution status, when rendering a live run (omit for the static workflow). */
export type StepStatuses = Record<string, string>;

function statusTone(status: string | undefined): {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
} | null {
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
}

/** Icon glyph for an integration step's target system. */
function integrationGlyph(kind: string): string {
  if (kind === "netsuite") return "NS";
  if (kind === "slack") return "#";
  if (kind === "jira") return "J";
  return "→";
}

function StepNode({
  step,
  status,
  dimmed,
}: {
  step: WorkflowStep;
  status?: string;
  dimmed?: boolean;
}) {
  const st = statusTone(status);
  const isApproval = step.kind === "approval";
  const condition = describeCondition(step.when);
  const unconditional = step.when.kind === "always";

  return (
    <div
      className={`w-full rounded-lg bg-surface px-3 py-2 ring-1 ring-inset ring-line shadow-card ${
        dimmed ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
          {isApproval ? (
            <span className="grid size-5 place-items-center rounded-full bg-canvas text-[10px] text-muted ring-1 ring-inset ring-line">
              ✓
            </span>
          ) : (
            <span className="grid size-5 place-items-center rounded-full bg-accent/10 text-[9px] font-semibold text-accent ring-1 ring-inset ring-accent/20">
              {integrationGlyph((step as { integration: string }).integration)}
            </span>
          )}
          {step.label}
        </span>
        {st && <Badge tone={st.tone}>{st.label}</Badge>}
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
              ⚠ unresolved — {step.approverTitle} (assign a person)
            </span>
          )}
        </div>
      )}

      {!unconditional && (
        <div className="mt-1.5 pl-7">
          <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-muted ring-1 ring-inset ring-line">
            when {condition}
          </span>
        </div>
      )}
    </div>
  );
}

/** A small connector line between flow rows. */
function Connector() {
  return <div className="mx-auto h-4 w-px bg-line" aria-hidden />;
}

export function WorkflowGraph({
  workflow,
  statuses,
}: {
  workflow: ApprovalWorkflow;
  statuses?: StepStatuses;
}) {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));

  // Layout: walk from the roots. A step that fans out to >1 NEXT renders those as
  // parallel lanes; lanes that all converge on the same downstream step rejoin
  // before it. The template is shallow (root → fan-out → join), so a simple
  // three-band layout (roots / fan-out lanes / shared tail) reads cleanly without
  // a general graph layout engine.
  const roots = workflow.roots
    .map((id) => byId.get(id))
    .filter(Boolean) as WorkflowStep[];

  // The "tail" = steps every branch converges on (here: the final post). Detect as
  // steps that are the `next` of multiple other steps.
  const incoming = new Map<string, number>();
  for (const s of workflow.steps)
    for (const n of s.next) incoming.set(n, (incoming.get(n) ?? 0) + 1);
  const tailIds = new Set(
    [...incoming.entries()].filter(([, c]) => c > 1).map(([id]) => id),
  );

  // Fan-out lanes: the root's next steps that aren't the shared tail.
  const root = roots[0];
  const laneIds = root ? root.next.filter((id) => !tailIds.has(id)) : [];
  const lanes = laneIds
    .map((id) => byId.get(id))
    .filter(Boolean) as WorkflowStep[];
  const tail = [...tailIds]
    .map((id) => byId.get(id))
    .filter(Boolean) as WorkflowStep[];

  return (
    <div className="space-y-0">
      {/* Root gate */}
      {root && <StepNode step={root} status={statuses?.[root.id]} />}

      {lanes.length > 0 && (
        <>
          <Connector />
          {/* Parallel lanes */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {lanes.map((s) => (
              <StepNode key={s.id} step={s} status={statuses?.[s.id]} />
            ))}
          </div>
        </>
      )}

      {tail.length > 0 && (
        <>
          <Connector />
          {tail.map((s) => (
            <StepNode key={s.id} step={s} status={statuses?.[s.id]} />
          ))}
        </>
      )}
    </div>
  );
}
