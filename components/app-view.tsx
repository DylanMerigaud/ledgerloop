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
    <div className="inline-flex w-fit items-center gap-1 rounded-xl bg-subtle p-1 ring-1 ring-inset ring-line">
      <TabButton
        active={view === "onboarding"}
        onClick={() => onChange("onboarding")}
        step={1}
        label="Onboarding"
        hint="Derive the workflow"
      />
      <TabButton
        active={view === "pipeline"}
        onClick={() => onChange("pipeline")}
        step={2}
        label="Pipeline"
        hint="Run invoices"
      />
    </div>
  );
};

const TabButton = ({
  active,
  onClick,
  step,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  step: number;
  label: string;
  hint: string;
}) => {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2.5 rounded-lg px-3.5 py-2 text-left transition-all ${
        active
          ? "bg-surface shadow-card ring-1 ring-inset ring-line"
          : "hover:bg-surface/60"
      }`}
    >
      <span
        className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold transition-colors ${
          active
            ? "bg-accent text-accent-fg"
            : "bg-line-strong/60 text-muted group-hover:bg-line-strong"
        }`}
      >
        {step}
      </span>
      <span className="flex flex-col leading-tight">
        <span
          className={`text-[13px] font-semibold ${active ? "text-ink" : "text-muted"}`}
        >
          {label}
        </span>
        <span
          className={`text-[11px] ${active ? "text-faint" : "text-faint/80"}`}
        >
          {hint}
        </span>
      </span>
    </button>
  );
};
