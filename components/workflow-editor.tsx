"use client";

import { useState } from "react";

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

const SUGGESTIONS = [
  "Above $25k, also require CFO approval",
  "Add a Slack notification when an invoice posts",
  "Route Marketing purchases through a marketing lead",
];

export const WorkflowEditor = ({ initial }: { initial: ApprovalWorkflow }) => {
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
      const data = (await res.json()) as Proposal;
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
      {/* The graph — proposal (with diff) when one is pending, else the current workflow */}
      <div className="flex-1 overflow-y-auto">
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
        <div className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2 ring-1 ring-inset ring-line">
          <span className="text-[12px] text-muted">
            Proposed edit · {changedCount} change{changedCount === 1 ? "" : "s"}{" "}
            <span className="text-muted/70">— not applied yet</span>
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={revert}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-muted ring-1 ring-inset ring-line transition-colors hover:text-ink"
            >
              Revert
            </button>
            <button
              onClick={approve}
              className="rounded-md bg-ink px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-ink/90"
            >
              Approve
            </button>
          </div>
        </div>
      )}

      {/* Chat input */}
      <div className="space-y-1.5">
        {error && (
          <div className="rounded-lg bg-danger-soft px-3 py-1.5 text-[12px] text-danger ring-1 ring-inset ring-danger-line">
            {error}
          </div>
        )}
        {!proposal && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => submit(s)}
                disabled={busy}
                className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted ring-1 ring-inset ring-line transition-colors hover:text-ink disabled:opacity-50"
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
            className="flex-1 rounded-lg bg-surface px-3 py-2 text-[13px] text-ink ring-1 ring-inset ring-line outline-none placeholder:text-muted focus:ring-accent disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !instruction.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? "…" : "Edit"}
          </button>
        </form>
      </div>
    </div>
  );
};
