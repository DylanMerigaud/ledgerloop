import { Badge } from "@/components/ui/badge";
import type {
  ApprovalWorkflow,
  WorkflowStep,
  StepChange,
} from "@/lib/approval-workflow";
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

const statusTone = (
  status: string | undefined,
): {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
} | null => {
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

/** Icon glyph for an integration step's target system. */
const integrationGlyph = (kind: string): string => {
  if (kind === "netsuite") return "NS";
  if (kind === "slack") return "#";
  if (kind === "jira") return "J";
  return "→";
};

/** Diff ring + chip for a step when rendering a proposed edit. */
const changeStyle = (
  change: StepChange["kind"] | undefined,
): {
  ring: string;
  badge: { tone: "ok" | "warn" | "danger"; label: string } | null;
} => {
  switch (change) {
    case "added":
      return {
        ring: "ring-ok-line bg-ok-soft/30",
        badge: { tone: "ok", label: "Added" },
      };
    case "changed":
      return {
        ring: "ring-warn-line bg-warn-soft/30",
        badge: { tone: "warn", label: "Changed" },
      };
    case "removed":
      return {
        ring: "ring-danger-line bg-danger-soft/30",
        badge: { tone: "danger", label: "Removed" },
      };
    default:
      return { ring: "ring-line", badge: null };
  }
};

const StepNode = ({
  step,
  status,
  change,
  dimmed,
}: {
  step: WorkflowStep;
  status?: string;
  change?: StepChange["kind"];
  dimmed?: boolean;
}) => {
  const st = statusTone(status);
  const cs = changeStyle(change);
  const isApproval = step.kind === "approval";
  const condition = describeCondition(step.when);
  const unconditional = step.when.kind === "always";

  return (
    <div
      className={`w-full rounded-lg bg-surface px-3 py-2 ring-1 ring-inset shadow-card ${cs.ring} ${
        dimmed || change === "removed" ? "opacity-60" : ""
      } ${change === "removed" ? "line-through" : ""}`}
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
        {cs.badge ? (
          <Badge tone={cs.badge.tone}>{cs.badge.label}</Badge>
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
};

/** A horizontal connector between flow columns (left → right). */
const Connector = () => {
  return (
    <div className="flex shrink-0 items-center self-center" aria-hidden>
      <div className="h-px w-6 bg-line" />
      <div className="-ml-1 text-line">▸</div>
    </div>
  );
};

/** One column in the left→right flow (a fixed-width band of one or more nodes). */
const Column = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="flex w-60 shrink-0 flex-col justify-center gap-3">
      {children}
    </div>
  );
};

export const WorkflowGraph = ({
  workflow,
  statuses,
  changes,
}: {
  workflow: ApprovalWorkflow;
  statuses?: StepStatuses;
  /** When rendering a proposed edit, per-step change kinds for diff colouring. */
  changes?: StepChange[];
}) => {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const changeOf = new Map((changes ?? []).map((c) => [c.id, c.kind]));

  // Layout is LEFT → RIGHT (the category convention — cf. the Pivot/Ramp/Zip
  // canvases): the root gate, then its fan-out steps stacked as parallel rows in
  // the middle column, rejoining at the shared tail on the right. The template is
  // shallow (root → fan-out → join), so a three-column band reads cleanly without
  // a general graph-layout engine. Scrolls horizontally if it overflows.
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

  // Removed steps aren't in the proposed workflow's `steps`; surface them (struck)
  // from the diff so the preview shows what's going away.
  const removed = (changes ?? []).filter((c) => c.kind === "removed");

  return (
    <div className="flex items-stretch gap-0 overflow-x-auto pb-2">
      {/* Root gate */}
      {root && (
        <Column>
          <StepNode
            step={root}
            status={statuses?.[root.id]}
            change={changeOf.get(root.id)}
          />
        </Column>
      )}

      {lanes.length > 0 && (
        <>
          <Connector />
          {/* Parallel lanes — stacked rows in one column */}
          <Column>
            {lanes.map((s) => (
              <StepNode
                key={s.id}
                step={s}
                status={statuses?.[s.id]}
                change={changeOf.get(s.id)}
              />
            ))}
          </Column>
        </>
      )}

      {tail.length > 0 && (
        <>
          <Connector />
          <Column>
            {tail.map((s) => (
              <StepNode
                key={s.id}
                step={s}
                status={statuses?.[s.id]}
                change={changeOf.get(s.id)}
              />
            ))}
          </Column>
        </>
      )}

      {removed.length > 0 && (
        <>
          <Connector />
          <Column>
            {removed.map((c) => (
              <div
                key={c.id}
                className="rounded-lg bg-danger-soft/30 px-3 py-2 text-[13px] font-medium text-ink line-through opacity-60 ring-1 ring-inset ring-danger-line"
              >
                {c.label}
              </div>
            ))}
          </Column>
        </>
      )}
    </div>
  );
};
