"use client";

import { useEffect, useState } from "react";

import { WorkflowGraph } from "@/components/workflow-graph";
import { type InvoiceContext, resolvePath } from "@/lib/approval-workflow";
import { DEFAULT_APPROVAL_POLICY, workflowFromPolicy } from "@/lib/client-profile";

/**
 * A deterministic render harness for the graph LAYOUT, no model calls, so the e2e
 * (`e2e/workflow-graph.e2e.ts`) can assert handle alignment across the shapes that used
 * to kink: a linear chain (different node heights), a fan-out (branches straddle the
 * spine), and the base workflow WITH conditions (the diamond, a direct fall-through
 * alongside the escalation path). Each case is a labelled sub-canvas.
 */

const base = workflowFromPolicy(DEFAULT_APPROVAL_POLICY);

// LINEAR: an exception over the manager floor ($1000) but under the director threshold
// ($10000) → manager fires, director is pruned → Manager → Post, two nodes of very
// different heights on one straight line.
const mgrOnlyCtx: InvoiceContext = {
  amount: 2000,
  exceptionAmount: 2000,
  variancePct: 0.02,
  department: "Ops",
  verdict: "exception",
  vendor: "Acme",
  currency: "USD",
  matchType: "three_way",
  exceptionCodes: ["price_mismatch"],
};
const linear = resolvePath(base, mgrOnlyCtx);

// Renders the linear chain, then applies status badges a beat later, to reproduce a
// live run's sequence (layout on plain cards, then the badges grow them).
const LinearLit = () => {
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  useEffect(() => {
    const t = setTimeout(
      () => setStatuses({ "manager-review": "approved", "post-netsuite": "done" }),
      1200
    );
    return () => clearTimeout(t);
  }, []);
  return <WorkflowGraph workflow={linear} statuses={statuses} />;
};

export default function GraphCases() {
  return (
    <div style={{ height: "100vh", width: "100vw", background: "#fafafa" }}>
      <div style={{ height: "25%" }} data-testid="case-linear">
        <WorkflowGraph workflow={linear} />
      </div>
      <div style={{ height: "25%" }} data-testid="case-linear-lit">
        {/* The #51 case: statuses arrive AFTER the initial layout (like a live run), so
            the status badges grow the cards a beat later. Renders with no statuses, then
            sets them, to reproduce the exact sequence. */}
        <LinearLit />
      </div>
      <div style={{ height: "25%" }} data-testid="case-diamond">
        {/* The base workflow with conditions: Manager → {Director, Post}. */}
        <WorkflowGraph workflow={base} />
      </div>
      <div style={{ height: "25%" }} data-testid="case-fanout">
        {/* A pure fan-out that all rejoin the post (no direct fall-through), so the two
            branches straddle the spine symmetrically. */}
        <WorkflowGraph workflow={fanout} />
      </div>
    </div>
  );
}

// FAN-OUT: Manager → {Director, Dept} → Post (both branches conditional, both rejoin
// post). Built off the base by rewiring so manager does NOT post directly, isolating
// the symmetric fan-out case.
const fanout = (() => {
  const wf = structuredClone(base);
  const mgr = wf.steps.find((s) => s.id === "manager-review");
  const dir = wf.steps.find((s) => s.id === "director-review");
  if (mgr && dir) {
    // Add a second branch (a dept clone of director) and drop the direct manager→post.
    const dept = {
      ...structuredClone(dir),
      id: "dept-review",
      label: "Dept review",
    };
    wf.steps.push(dept);
    mgr.next = ["director-review", "dept-review"];
    dept.next = ["post-netsuite"];
  }
  return wf;
})();
