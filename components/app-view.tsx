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

export function AppView({ queue }: { queue: QueueItem[] }) {
  const [view, setView] = useState<View>("onboarding");

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Tabs view={view} onChange={setView} />
      <div className="min-h-0 flex-1">
        {view === "onboarding" ? <Onboarding /> : <Dashboard queue={queue} />}
      </div>
    </div>
  );
}

function Tabs({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="inline-flex w-fit items-center gap-0.5 rounded-lg bg-canvas p-0.5 ring-1 ring-inset ring-line">
      <TabButton
        active={view === "onboarding"}
        onClick={() => onChange("onboarding")}
      >
        1 · Onboarding
      </TabButton>
      <TabButton
        active={view === "pipeline"}
        onClick={() => onChange("pipeline")}
      >
        2 · Pipeline
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
        active ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
