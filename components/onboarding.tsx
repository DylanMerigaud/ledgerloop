"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkflowEditor } from "@/components/workflow-editor";
import { API_ROUTES } from "@/lib/api-routes";
import type { ApprovalWorkflow } from "@/lib/approval-workflow";

/**
 * The onboarding discovery screen — the forward-deployed-engineer step.
 *
 * The differentiator made visible: you don't draw an approval workflow on a
 * canvas (the way every competitor's builder works). You point the agent at the
 * client's HRIS and it DERIVES the workflow — who approves what, resolved to real
 * people from the org chart — and flags the data-quality problems a human must fix
 * first. This screen runs that discovery and shows the result for validation.
 *
 * It reads from POST /api/onboarding (the agent over the real/recorded org). The
 * output is a PROPOSAL: the human reviews the resolved approvers and the flagged
 * issues before it goes live. (Conversational edits are the next layer.)
 */

type RoleResolution = {
  role: string;
  title: string;
  employeeName: string | null;
  rationale: string;
};
type OrgEmployee = {
  id: string;
  name: string;
  title: string;
  department: string;
  division: string;
  managerId: string | null;
};
type OnboardingResponse = {
  source: string;
  employeeCount: number;
  employees: OrgEmployee[];
  workflow: ApprovalWorkflow;
  proposal: {
    directorThreshold: number;
    roles: RoleResolution[];
    summary: string;
  };
  issues: { employeeName: string; detail: string; note: string }[];
};

type State =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; data: OnboardingResponse };

export const Onboarding = () => {
  const [state, setState] = useState<State>({ status: "idle" });

  const discover = async () => {
    setState({ status: "running" });
    try {
      const res = await fetch(API_ROUTES.onboarding, { method: "POST" });
      if (!res.ok) {
        const msg = await res
          .json()
          .then((j: { error?: string }) => j.error)
          .catch(() => null);
        setState({ status: "error", message: msg ?? "Discovery failed." });
        return;
      }
      const data = (await res.json()) as OnboardingResponse;
      setState({ status: "done", data });
    } catch {
      setState({ status: "error", message: "Could not reach the server." });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(300px,400px)_1fr]">
      {/* LEFT — the action + what was discovered about the org */}
      <Card className="flex max-h-[80vh] flex-col overflow-hidden lg:max-h-none">
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Onboarding · HRIS discovery</CardTitle>
          {state.status === "done" && (
            <Badge tone="neutral">{state.data.source}</Badge>
          )}
        </CardHeader>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="text-[13px] leading-relaxed text-muted">
            Connect the client&apos;s HR system and the agent derives their
            approval workflow — who signs off on what, resolved to real people
            from the org chart — and flags the data issues to fix before going
            live.
          </p>
          <button
            onClick={discover}
            disabled={state.status === "running"}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-ink/90 disabled:opacity-60"
          >
            {state.status === "running" ? (
              <>
                <Spinner /> Reading org &amp; deriving workflow…
              </>
            ) : state.status === "done" ? (
              "Re-run discovery"
            ) : (
              "Discover from BambooHR"
            )}
          </button>

          {state.status === "error" && (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-[12px] text-danger ring-1 ring-inset ring-danger-line">
              {state.message}
            </div>
          )}

          {state.status === "done" && <DiscoverySummary data={state.data} />}
        </div>
      </Card>

      {/* RIGHT — the derived workflow */}
      <Card className="flex flex-col overflow-hidden">
        <CardHeader className="flex items-center justify-between gap-3">
          <CardTitle>Derived approval workflow</CardTitle>
          {state.status === "done" && (
            <span className="text-[11px] text-muted">
              edit in plain language · approve to apply
            </span>
          )}
        </CardHeader>
        <div className="flex-1 overflow-hidden p-4">
          {state.status === "done" ? (
            // Key by the discovered workflow so a re-run resets the editor state.
            <WorkflowEditor
              key={state.data.workflow.name + state.data.employeeCount}
              initial={state.data.workflow}
            />
          ) : (
            <EmptyState running={state.status === "running"} />
          )}
        </div>
      </Card>
    </div>
  );
};

/**
 * The org as a reporting tree (roots at top, reports nested), with people the
 * agent flagged highlighted — so a viewer can see the data issues against the real
 * chart (the junk record, the orphan with no manager) instead of just a count.
 */
const OrgTree = ({
  employees,
  issues,
}: {
  employees: OrgEmployee[];
  issues: { employeeName: string; detail: string; note: string }[];
}) => {
  // Flag exactly the people an issue is ABOUT (by subject name), not anyone merely
  // mentioned in a note.
  const flaggedNames = new Set(issues.map((i) => i.employeeName));
  const flagged = new Set(
    employees.filter((e) => flaggedNames.has(e.name)).map((e) => e.id),
  );

  // Build children-by-manager. Anyone whose managerId isn't a real employee (or is
  // null) is a root — which surfaces the orphans/dangling managers visually.
  const ids = new Set(employees.map((e) => e.id));
  const childrenOf = new Map<string | null, OrgEmployee[]>();
  for (const e of employees) {
    const key = e.managerId && ids.has(e.managerId) ? e.managerId : null;
    const list = childrenOf.get(key) ?? [];
    list.push(e);
    childrenOf.set(key, list);
  }

  const renderNodes = (
    parent: string | null,
    depth: number,
  ): React.ReactNode => {
    const nodes = childrenOf.get(parent) ?? [];
    return nodes.map((e) => (
      <div key={e.id}>
        <div
          className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] ${
            flagged.has(e.id)
              ? "bg-warn-soft ring-1 ring-inset ring-warn-line"
              : ""
          }`}
          style={{ marginLeft: depth * 14 }}
        >
          {depth > 0 && <span className="text-line">└</span>}
          <span className="font-medium text-ink">{e.name}</span>
          <span className="text-muted">
            {e.title ? `· ${e.title}` : "· (no title)"}
          </span>
          {flagged.has(e.id) && <span className="ml-auto text-warn">⚠</span>}
        </div>
        {renderNodes(e.id, depth + 1)}
      </div>
    ));
  };

  return <div className="space-y-0.5">{renderNodes(null, 0)}</div>;
};

const DiscoverySummary = ({ data }: { data: OnboardingResponse }) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Badge tone="ok">{data.employeeCount} employees read</Badge>
        {data.issues.length > 0 && (
          <Badge tone="warn">{data.issues.length} issues flagged</Badge>
        )}
      </div>

      <p className="text-[12px] leading-relaxed text-ink">
        {data.proposal.summary}
      </p>

      {/* The org the agent read — flagged people highlighted so the issues are
          legible against the actual chart. */}
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
          Org chart ({data.employees.length})
        </h4>
        <OrgTree employees={data.employees} issues={data.issues} />
      </div>

      {/* Role resolutions — the fuzzy work the agent did */}
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
          Approvers resolved from the org
        </h4>
        <div className="space-y-1.5">
          {data.proposal.roles.map((r) => (
            <div
              key={r.role}
              className="rounded-lg bg-canvas px-2.5 py-1.5 ring-1 ring-inset ring-line"
            >
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium capitalize text-ink">
                  {r.role.replace("-", " ")}
                </span>
                <span className="text-[12px] text-muted">
                  {r.employeeName ?? (
                    <span className="text-warn">unresolved</span>
                  )}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-muted">
                {r.rationale}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Data-quality issues — what a human must fix */}
      {data.issues.length > 0 && (
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            Fix before activating
          </h4>
          <ul className="space-y-1">
            {data.issues.map((iss, i) => (
              <li
                key={i}
                className="flex gap-2 rounded-lg bg-warn-soft px-2.5 py-1.5 text-[11px] leading-snug text-ink ring-1 ring-inset ring-warn-line"
              >
                <span className="text-warn">⚠</span>
                <span>{iss.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const EmptyState = ({ running }: { running: boolean }) => {
  return (
    <div className="grid h-full min-h-48 place-items-center text-center">
      <div className="max-w-sm space-y-2">
        {running ? (
          <>
            <Spinner large />
            <p className="text-[13px] text-muted">
              The agent is reading the org and deriving the approval workflow…
            </p>
          </>
        ) : (
          <p className="text-[13px] text-muted">
            Run discovery to see the workflow the agent derives from the
            client&apos;s org chart.
          </p>
        )}
      </div>
    </div>
  );
};

const Spinner = ({ large }: { large?: boolean }) => {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${
        large ? "size-6 text-muted" : "size-3.5"
      }`}
      aria-hidden
    />
  );
};
