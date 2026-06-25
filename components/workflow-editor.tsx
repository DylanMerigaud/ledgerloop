"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { WorkflowGraph } from "@/components/workflow-graph";
import { API_ROUTES } from "@/lib/api-routes";
import type { ApprovalWorkflow, StepChange } from "@/lib/approval-workflow";

/**
 * The conversational workflow editor — the layer competitors don't have.
 *
 * You type what you want ("above $10k add a CFO approval") and the agent proposes
 * a rewrite. Nothing is applied until you APPROVE: the graph shows the proposal
 * with the diff (added / changed / removed), and you either keep it (the proposal
 * becomes the current workflow) or revert (discard it). The current workflow is
 * the only thing that would ever drive the pipeline — the proposal is preview-only.
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
}: {
  initial: ApprovalWorkflow;
  /** AI-generated next-edit suggestions for the initial workflow (may be empty). */
  suggestions?: string[];
}) => {
  const [current, setCurrent] = useState<ApprovalWorkflow>(initial);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (text: string) => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(API_ROUTES.workflowEdit, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: current, instruction: value }),
      });
      if (!res.ok) {
        const msg = await res
          .json()
          .then((j: { error?: string }) => j.error)
          .catch(() => null);
        setError(msg ?? "Edit failed.");
        return;
      }
      const data = (await res.json()) as Proposal & { reason?: string | null };
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
      setProposal(data);
      setInstruction("");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    if (!proposal) return;
    setCurrent(proposal.proposed); // the proposal becomes live
    setProposal(null);
  };
  const revert = () => {
    setProposal(null); // discard — current is untouched
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
          />
        ) : (
          <WorkflowGraph workflow={current} />
        )}
      </div>

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
            <Button size="sm" onClick={approve}>
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
            proposal, and only when the model actually returned some — no fixed
            chips, so a suggestion is always a real, applicable next step. */}
        {!proposal && suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-faint">
              Suggested
            </span>
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => submit(s)}
                disabled={busy}
                className="rounded-full bg-subtle px-3 py-1.5 text-[11.5px] font-medium text-muted ring-1 ring-inset ring-line-strong transition-colors hover:bg-accent-soft hover:text-accent hover:ring-accent/20 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
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
            placeholder="Tell the agent how to change the workflow…"
            className="h-10 flex-1 rounded-lg bg-surface px-3.5 text-[13px] text-ink shadow-card outline-none ring-1 ring-inset ring-line-strong transition-shadow placeholder:text-faint focus:ring-2 focus:ring-accent-ring disabled:opacity-60"
          />
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
