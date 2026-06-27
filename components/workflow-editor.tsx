"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { NodeEditPanel } from "@/components/node-edit-panel";
import { Button } from "@/components/ui/button";
import { WorkflowGraph } from "@/components/workflow-graph";
import { useEventCallback } from "@/hooks/use-event-callback";
import type { ApprovalWorkflow, StepChange } from "@/lib/approval-workflow";
import { orpc } from "@/lib/orpc/client";
import type { OrgEmployee } from "@/lib/orpc/schemas";
import { applyEditOp } from "@/lib/workflow-edit";
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
  departments = [],
  vendors = [],
  currencies = [],
  people = [],
  onCurrentChange,
}: {
  initial: ApprovalWorkflow;
  /** AI-generated next-edit suggestions for the initial workflow (may be empty). */
  suggestions?: string[];
  /** The departments that exist in the org — offered in the node-edit condition
      editor and the "What can I change?" doc, and sent to the edit agent so it only
      ever proposes a real one. */
  departments?: string[];
  /** The vendors / currencies present on the invoices — sent to the edit agent so a
      vendor/currency gate targets a real one (it declines an unknown value). */
  vendors?: string[];
  currencies?: string[];
  /** The org's people — for the node panel's approver picker (click a gate to edit). */
  people?: OrgEmployee[];
  /** Called with the CURRENT (approved) workflow whenever it changes — the initial
      one, then each kept edit. Never the pending proposal (preview-only). Lets a
      parent (AppView) run the pipeline against exactly what's on screen here. */
  onCurrentChange?: (workflow: ApprovalWorkflow) => void;
}) => {
  const [current, setCurrent] = useState<ApprovalWorkflow>(initial);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // The graph node selected for editing (the side panel). Cleared on revert/reset.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A pending clarification from the agent ("which department?") + the instruction
  // that triggered it, so clicking an option can re-submit a completed instruction.
  const [clarify, setClarify] = useState<{
    question: string;
    options: string[];
    instruction: string;
  } | null>(null);
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
        departments,
        vendors,
        currencies,
      });
      // The agent needs a missing piece (e.g. which department) — offer the options
      // instead of an edit. Remember the instruction so a pick can complete it.
      if (data.clarify) {
        setClarify({ ...data.clarify, instruction: value });
        setInstruction("");
        return;
      }
      setClarify(null);
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

  /** The user picked a clarification option → re-submit the original instruction
      completed with the choice (re-uses the whole edit flow). */
  const pickClarifyOption = (option: string) => {
    const base = clarify?.instruction ?? "";
    setClarify(null);
    void submit(`${base} for ${option}`);
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
    setClarify(null);
    setSelectedId(null);
  };

  const changedCount = proposal
    ? proposal.changes.filter((c) => c.kind !== "unchanged").length
    : 0;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* The graph — proposal (with diff) when one is pending, else the current
          workflow. React Flow owns pan/zoom, so give it height (min-h-0) and let
          it handle overflow rather than a scroll container. */}
      {/* The canvas fills the remaining height on desktop; on mobile the column is
          tall and `flex-1` would collapse it under the chips/input, so give it a
          real minimum so the graph stays legible (pan/zoom by touch). */}
      <div className="relative min-h-[420px] flex-1 overflow-hidden rounded-xl bg-subtle/30 ring-1 ring-inset ring-line sm:min-h-[360px]">
        {proposal ? (
          // Previewing an edit — no node-editing while a proposal is pending (approve
          // or revert first), so the two edit paths can't collide.
          <WorkflowGraph
            workflow={proposal.proposed}
            changes={proposal.changes}
            issues={issues}
          />
        ) : (
          <WorkflowGraph
            workflow={current}
            issues={issues}
            onNodeSelect={setSelectedId}
            selectedId={selectedId}
          />
        )}
        {/* Click a node → edit it here (onboarding only). Direct/deterministic via
            applyEditOp; the emitCurrent effect pushes `current` up to AppView. */}
        {!proposal && selectedId && (
          <NodeEditPanel
            workflow={current}
            stepId={selectedId}
            people={people}
            available={{ departments, vendors, currencies }}
            onApply={(op) => setCurrent((wf) => applyEditOp(wf, op))}
            onClose={() => setSelectedId(null)}
          />
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
        {/* The agent asked for a missing piece (e.g. which department) — show its
            question + the choices as chips. Clicking one re-submits the completed
            instruction. Takes over the chip area while it's pending. */}
        {!proposal && clarify && (
          <div className="space-y-1.5 rounded-xl bg-accent-soft/40 px-3 py-2.5 ring-1 ring-inset ring-accent/15">
            <p className="text-[12.5px] font-medium text-ink">
              {clarify.question}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {clarify.options.map((o) => (
                <DeptChip
                  key={o}
                  label={o}
                  onClick={() => pickClarifyOption(o)}
                  disabled={busy}
                />
              ))}
            </div>
          </div>
        )}
        {/* AI-suggested next edits for this workflow. Only shown before a pending
            proposal, and only when the model returned some — no fixed chips, so a
            suggestion is always a real, applicable next step. A used chip is
            removed (consumed) once it produces a proposal. */}
        {!proposal && !clarify && chips.length > 0 && (
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
 * The validation summary. Renders nothing when the workflow is clean; otherwise the
 * list of errors (red, block applying) and warnings (amber, control best-practices).
 * This is what shows the tool understands the workflow, not just draws it.
 */
const ValidationPanel = ({ issues }: { issues: WorkflowIssue[] }) => {
  // Nothing to flag → show nothing. A clean workflow doesn't need a banner taking a
  // row; the checks only surface when there's an error or a best-practice warning.
  if (issues.length === 0) return null;
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

/**
 * Stable decorative hue from a label (not semantic — it must NOT reuse ok/danger
 * tones, which carry meaning). Same name → same colour across renders, so the org's
 * departments read as a consistent little palette.
 */
const hueFor = (label: string): number => {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

/**
 * A clarification chip: the app's interactive accent chip plus a small coloured dot
 * keyed to the label, so a row of options looks alive without inventing a semantic
 * colour scale. Used for the agent's "which department?" choices — clicking one
 * re-submits the completed instruction.
 */
const DeptChip = ({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) => {
  const hue = hueFor(label);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg bg-subtle px-2.5 py-1.5 text-[12px] font-medium text-muted ring-1 ring-inset ring-line-strong transition-colors hover:bg-accent-soft hover:text-accent hover:ring-accent/30 disabled:opacity-50"
    >
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ backgroundColor: `hsl(${hue} 55% 55%)` }}
      />
      {label}
    </button>
  );
};
