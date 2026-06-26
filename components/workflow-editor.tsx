"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { WorkflowGraph } from "@/components/workflow-graph";
import { useEventCallback } from "@/hooks/use-event-callback";
import type { ApprovalWorkflow, StepChange } from "@/lib/approval-workflow";
import { orpc } from "@/lib/orpc/client";
import {
  validateWorkflow,
  isActivatable,
  type WorkflowIssue,
} from "@/lib/workflow-validate";

/**
 * The conversational workflow editor — the layer competitors don't have.
 *
 * You type what you want ("above $10k add a CFO approval") and a structured-output
 * model maps it to one edit op, which deterministic code applies to PROPOSE a
 * rewrite (it's plain-language editing, not an open-ended agent). Nothing applies
 * until you APPROVE: the graph shows the proposal with the diff (added / changed /
 * removed), and you keep it (the proposal becomes current) or revert (discard it).
 * The current workflow is the only thing that drives the pipeline — proposal is
 * preview-only.
 *
 * Holds two workflows: `current` (the approved one) and an optional `proposal`
 * (a pending edit). Reads POST /api/workflow/edit.
 */

type Proposal = {
  proposed: ApprovalWorkflow;
  changes: StepChange[];
};

export const WorkflowEditor = ({
  initial,
  suggestions = [],
  onCurrentChange,
}: {
  initial: ApprovalWorkflow;
  /** AI-generated next-edit suggestions for the initial workflow (may be empty). */
  suggestions?: string[];
  /** Called with the CURRENT (approved) workflow whenever it changes — the initial
      one, then each kept edit. Never the pending proposal (preview-only). Lets a
      parent (AppView) run the pipeline against exactly what's on screen here. */
  onCurrentChange?: (workflow: ApprovalWorkflow) => void;
}) => {
  const [current, setCurrent] = useState<ApprovalWorkflow>(initial);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Suggestions are consumable: once one produces a proposal it's removed, so a
  // chip never lingers after it's been used.
  const [chips, setChips] = useState<string[]>(suggestions);

  // Surface the current (approved) workflow to the parent whenever it changes —
  // the initial derived one and every kept edit, so the pipeline runs against
  // exactly this. Stable callback (useEventCallback) so the effect keys only on
  // `current`. The proposal never flows here: it's preview-only until approved.
  const emitCurrent = useEventCallback((wf: ApprovalWorkflow) =>
    onCurrentChange?.(wf),
  );
  useEffect(() => emitCurrent(current), [current, emitCurrent]);

  // The edit is a TanStack Query mutation over the typed oRPC procedure;
  // `isPending` is the busy state.
  const editMutation = useMutation(orpc.editWorkflow.mutationOptions());
  const busy = editMutation.isPending;

  const submit = async (text: string) => {
    const value = text.trim();
    if (!value || busy) return;
    setError(null);
    try {
      const data = await editMutation.mutateAsync({
        workflow: current,
        instruction: value,
      });
      const realChanges = data.changes.filter((c) => c.kind !== "unchanged");
      if (realChanges.length === 0) {
        // The agent declined (redundant / off-topic) — say so, don't offer a no-op.
        setError(
          data.reason
            ? `No change: ${data.reason}`
            : "No change — the workflow already does that.",
        );
        return;
      }
      setProposal({ proposed: data.proposed, changes: data.changes });
      setInstruction("");
      // Drop the chip we just used (if this came from one).
      setChips((cs) => cs.filter((c) => c !== value));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edit failed.");
    }
  };

  // Validate whatever's on screen (the proposal if pending, else the live one).
  // Errors block applying a proposal; warnings are surfaced but don't block.
  const shown = proposal?.proposed ?? current;
  const issues = useMemo(() => validateWorkflow(shown), [shown]);
  const canApply = isActivatable(issues);

  const approve = () => {
    if (!proposal || !isActivatable(validateWorkflow(proposal.proposed)))
      return;
    setCurrent(proposal.proposed); // the proposal becomes live
    setProposal(null);
  };
  const revert = () => {
    setProposal(null); // discard — current is untouched
  };
  // Reset = restore the originally-derived workflow (NOT recompute — that's the
  // left pane's "Re-run discovery"). Instant, deterministic.
  const isEdited = current !== initial;
  const reset = () => {
    setCurrent(initial);
    setProposal(null);
    setChips(suggestions);
    setError(null);
  };

  const changedCount = proposal
    ? proposal.changes.filter((c) => c.kind !== "unchanged").length
    : 0;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* The graph — proposal (with diff) when one is pending, else the current
          workflow. React Flow owns pan/zoom, so give it height (min-h-0) and let
          it handle overflow rather than a scroll container. */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-subtle/30 ring-1 ring-inset ring-line">
        {proposal ? (
          <WorkflowGraph
            workflow={proposal.proposed}
            changes={proposal.changes}
            issues={issues}
          />
        ) : (
          <WorkflowGraph workflow={current} issues={issues} />
        )}
      </div>

      {/* Validation summary — "sound" or the list of issues (errors block apply). */}
      <ValidationPanel issues={issues} />

      {/* Pending-edit bar: approve / revert */}
      {proposal && (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-accent-soft/60 px-3.5 py-2.5 ring-1 ring-inset ring-accent/15">
          <span className="text-[12.5px] font-medium text-ink">
            Proposed edit · {changedCount} change{changedCount === 1 ? "" : "s"}{" "}
            <span className="font-normal text-faint">not applied yet</span>
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={revert}>
              Revert
            </Button>
            <Button
              size="sm"
              onClick={approve}
              disabled={!canApply}
              title={canApply ? undefined : "Fix the errors before applying"}
            >
              Approve
            </Button>
          </div>
        </div>
      )}

      {/* Chat input */}
      <div className="space-y-2">
        {error && (
          <div className="rounded-xl bg-danger-soft/80 px-3.5 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger-line/70">
            {error}
          </div>
        )}
        {/* AI-suggested next edits for this workflow. Only shown before a pending
            proposal, and only when the model returned some — no fixed chips, so a
            suggestion is always a real, applicable next step. A used chip is
            removed (consumed) once it produces a proposal. */}
        {!proposal && chips.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
              <SparkIcon />
              Suggested edits
            </div>
            <div className="flex flex-col items-start gap-1.5">
              {chips.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  disabled={busy}
                  className="group inline-flex max-w-full items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-left text-[12px] font-medium text-muted ring-1 ring-inset ring-line-strong transition-colors hover:bg-accent-soft hover:text-accent hover:ring-accent/30 disabled:opacity-50"
                >
                  <span className="text-faint group-hover:text-accent">+</span>
                  <span className="truncate">{s}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(instruction);
          }}
          className="flex items-center gap-2"
        >
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={busy}
            placeholder="Describe a change in plain language…"
            className="h-10 flex-1 rounded-lg bg-surface px-3.5 text-[13px] text-ink shadow-card outline-none ring-1 ring-inset ring-line-strong transition-shadow placeholder:text-faint focus:ring-2 focus:ring-accent-ring disabled:opacity-60"
          />
          {isEdited && !proposal && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (
                  window.confirm(
                    "Discard all edits and restore the workflow the agent first derived?",
                  )
                )
                  reset();
              }}
              title="Restore the originally derived workflow"
            >
              Reset
            </Button>
          )}
          <Button
            type="submit"
            loading={busy}
            disabled={busy || !instruction.trim()}
          >
            {busy ? "Editing…" : "Edit"}
          </Button>
        </form>
      </div>
    </div>
  );
};

/**
 * The validation summary. "Sound" when there's nothing to flag; otherwise the list
 * of errors (red, block applying) and warnings (amber, control best-practices). This
 * is what shows the tool understands the workflow, not just draws it.
 */
const ValidationPanel = ({ issues }: { issues: WorkflowIssue[] }) => {
  if (issues.length === 0) {
    return (
      <div className="flex items-center gap-1.5 rounded-xl bg-ok-soft/50 px-3.5 py-2 text-[12px] font-medium text-ok ring-1 ring-inset ring-ok-line/60">
        <span aria-hidden>✓</span> Sound — passes the approval-control checks
      </div>
    );
  }
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return (
    <div className="space-y-1.5 rounded-xl bg-subtle/60 px-3 py-2.5 ring-1 ring-inset ring-line">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
        Checks
        {errors.length > 0 && (
          <span className="rounded-full bg-danger-soft px-1.5 py-0.5 text-danger">
            {errors.length} to fix
          </span>
        )}
        {warnings.length > 0 && (
          <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-warn">
            {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {issues.map((iss, i) => (
          <li
            key={`${iss.code}-${i}`}
            className="flex gap-2 text-[12px] leading-snug text-ink/90"
          >
            <span
              aria-hidden
              className={iss.severity === "error" ? "text-danger" : "text-warn"}
            >
              {iss.severity === "error" ? "✕" : "⚠"}
            </span>
            <span>{iss.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** A small four-point spark, marking the AI-generated suggestions. */
const SparkIcon = () => {
  return (
    <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden>
      <path d="M6 0c.3 2.5 1.5 3.7 4 4-2.5.3-3.7 1.5-4 4-.3-2.5-1.5-3.7-4-4 2.5-.3 3.7-1.5 4-4Z" />
    </svg>
  );
};
