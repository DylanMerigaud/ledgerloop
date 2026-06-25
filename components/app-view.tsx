"use client";

import { useState } from "react";

import { Dashboard } from "@/components/dashboard";
import { Onboarding } from "@/components/onboarding";
import type { QueueItem } from "@/db/client";

/**
 * The top-level view switch. Two halves of the product, in the order a
 * forward-deployed engineer works them:
 *   1. Onboarding — connect the client's HRIS, let the agent derive the approval
 *      workflow from their org. (The differentiator.)
 *   2. Pipeline — run invoices through that workflow, live.
 *
 * Client component (holds the active-tab state); the page stays a server
 * component that reads the queue and hands it down.
 */
type View = "onboarding" | "pipeline";

export const AppView = ({ queue }: { queue: QueueItem[] }) => {
  const [view, setView] = useState<View>("onboarding");

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Tabs view={view} onChange={setView} />
      <div className="min-h-0 flex-1">
        {view === "onboarding" ? <Onboarding /> : <Dashboard queue={queue} />}
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
