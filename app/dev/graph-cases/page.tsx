"use client";

import { WorkflowGraph } from "@/components/workflow-graph";
import { resolvePath, type InvoiceContext } from "@/lib/approval-workflow";
import {
  DEFAULT_APPROVAL_POLICY,
  workflowFromPolicy,
} from "@/lib/client-profile";

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

export default function GraphCases() {
  return (
    <div style={{ height: "100vh", width: "100vw", background: "#fafafa" }}>
      <div style={{ height: "34%" }} data-testid="case-linear">
        <WorkflowGraph workflow={linear} />
      </div>
      <div style={{ height: "33%" }} data-testid="case-diamond">
        {/* The base workflow with conditions: Manager → {Director, Post}. */}
        <WorkflowGraph workflow={base} />
      </div>
      <div style={{ height: "33%" }} data-testid="case-fanout">
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
