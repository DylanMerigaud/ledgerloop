"use client";

import { useState } from "react";

import { Dashboard } from "@/components/dashboard";
import { Onboarding } from "@/components/onboarding";
import type { QueueItem } from "@/db/client";
import type { ApprovalWorkflow } from "@/lib/approval-workflow";

/**
 * The top-level view switch. Two halves of the product, in the order a
 * forward-deployed engineer works them:
 *   1. Onboarding — connect the client's HRIS, let the agent derive the approval
 *      workflow from their org. (The differentiator.)
 *   2. Pipeline — run invoices through that workflow, live.
 *
 * It also owns the ONE shared piece of state between the two tabs: the active
 * approval workflow. Onboarding derives/edits it and pushes it up here; the
 * Pipeline reads it and runs every invoice through it. So there's a single
 * workflow, not a per-tab copy — edit it on the left, it's what executes on the
 * right. It lives in client state only (the run is stateless — nothing persisted);
 * until discovery has run it's null and the pipeline falls back to its default DAG.
 *
 * Both tabs stay MOUNTED — the inactive one is hidden, not unmounted — so the wow
 * loop holds: derive + edit on the left, switch to Pipeline, run, switch back, and
 * your discovery + edits are still there (and a run in flight isn't aborted). A
 * conditional render would drop all of that on every tab switch.
 *
 * Client component (holds the active tab + the shared workflow); the page stays a
 * server component that reads the queue and hands it down.
 */
type View = "onboarding" | "pipeline";

export const AppView = ({ queue }: { queue: QueueItem[] }) => {
  const [view, setView] = useState<View>("onboarding");
  // The single approval workflow shared across both tabs. null until the user
  // runs discovery; the pipeline falls back to its default DAG meanwhile.
  const [workflow, setWorkflow] = useState<ApprovalWorkflow | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Tabs view={view} onChange={setView} />
      <div className="min-h-0 flex-1">
        {/* Keep BOTH panes mounted; toggle visibility so per-tab state survives a
            switch. `hidden` collapses the inactive pane to zero box, so the active
            one keeps the full height (the panes use lg:h-full). */}
        <div className={view === "onboarding" ? "h-full" : "hidden"}>
          <Onboarding onWorkflowChange={setWorkflow} />
        </div>
        <div className={view === "pipeline" ? "h-full" : "hidden"}>
          <Dashboard queue={queue} workflow={workflow} />
        </div>
      </div>
    </div>
  );
};

const Tabs = ({
  view,
  onChange,
}: {
  view: View;
  onChange: (v: View) => void;
}) => {
  return (
    // Attio-style underline tabs: a row over a full-width hairline, the active
    // tab carries a black underline that overlaps the line.
    <div className="flex items-center gap-6 border-b border-line">
      <TabButton
        active={view === "onboarding"}
        onClick={() => onChange("onboarding")}
        step={1}
        label="Onboarding"
      />
      <TabButton
        active={view === "pipeline"}
        onClick={() => onChange("pipeline")}
        step={2}
        label="Pipeline"
      />
    </div>
  );
};

const TabButton = ({
  active,
  onClick,
  step,
  label,
}: {
  active: boolean;
  onClick: () => void;
  step: number;
  label: string;
}) => {
  return (
    <button
      onClick={onClick}
      className={`group relative -mb-px flex items-center gap-2 border-b-2 pb-2.5 pt-1 text-[13px] font-medium transition-colors ${
        active
          ? "border-ink text-ink"
          : "border-transparent text-muted hover:text-ink"
      }`}
    >
      <span
        className={`grid size-[18px] shrink-0 place-items-center rounded-full text-[10px] font-semibold transition-colors ${
          active
            ? "bg-ink text-white"
            : "bg-subtle text-faint ring-1 ring-inset ring-line-strong group-hover:text-muted"
        }`}
      >
        {step}
      </span>
      {label}
    </button>
  );
};
