"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, Eyebrow } from "@/components/ui/card";
import { WorkflowEditor } from "@/components/workflow-editor";
import { WorkflowGraph } from "@/components/workflow-graph";
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
        <CardHeader>
          <CardTitle>HRIS discovery</CardTitle>
          {state.status === "done" && (
            <Badge tone="neutral">{state.data.source}</Badge>
          )}
        </CardHeader>
        <div className="scrollbar-slim flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          <p className="text-[13px] leading-relaxed text-muted">
            Point the agent at the client&apos;s HR system. It reads the org
            chart, derives who signs off on what (resolved to real people), and
            flags the data issues to fix before going live.
          </p>
          <div>
            <Button onClick={discover} loading={state.status === "running"}>
              {state.status === "running"
                ? "Reading org…"
                : state.status === "done"
                  ? "Re-run discovery"
                  : "Discover from BambooHR"}
            </Button>
          </div>

          {state.status === "error" && (
            <div className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-[12px] text-danger ring-1 ring-inset ring-danger-line/70">
              {state.message}
            </div>
          )}

          {state.status === "done" ? (
            <DiscoverySummary data={state.data} />
          ) : (
            <DiscoveryPreview running={state.status === "running"} />
          )}
        </div>
      </Card>

      {/* RIGHT — the derived workflow */}
      <Card className="flex flex-col overflow-hidden">
        <CardHeader>
          <CardTitle>Derived approval workflow</CardTitle>
          {state.status === "done" && (
            <span className="hidden text-[11px] text-faint sm:inline">
              edit in plain language · approve to apply
            </span>
          )}
        </CardHeader>
        <div className="flex-1 overflow-hidden p-5">
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
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] ${
            flagged.has(e.id)
              ? "bg-warn-soft/80 ring-1 ring-inset ring-warn-line/60"
              : ""
          }`}
          style={{ marginLeft: depth * 14 }}
        >
          {depth > 0 && <span className="text-faint/60">└</span>}
          <span className="font-medium text-ink">{e.name}</span>
          <span className="text-faint">
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="ok">{data.employeeCount} employees read</Badge>
        {data.issues.length > 0 && (
          <Badge tone="warn">{data.issues.length} issues flagged</Badge>
        )}
      </div>

      <p className="text-[13px] leading-relaxed text-ink/90">
        {data.proposal.summary}
      </p>

      {/* The org the agent read — flagged people highlighted so the issues are
          legible against the actual chart. */}
      <section className="space-y-2">
        <Eyebrow>Org chart ({data.employees.length})</Eyebrow>
        <div className="rounded-xl bg-subtle/70 p-2 ring-1 ring-inset ring-line">
          <OrgTree employees={data.employees} issues={data.issues} />
        </div>
      </section>

      {/* Role resolutions — the fuzzy work the agent did */}
      <section className="space-y-2">
        <Eyebrow>Approvers resolved from the org</Eyebrow>
        <div className="space-y-1.5">
          {data.proposal.roles.map((r) => (
            <div
              key={r.role}
              className="rounded-xl bg-surface px-3 py-2 ring-1 ring-inset ring-line"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold capitalize text-ink">
                  {r.role.replace("-", " ")}
                </span>
                <span className="text-[12px] font-medium text-muted">
                  {r.employeeName ?? (
                    <span className="text-warn">unresolved</span>
                  )}
                </span>
              </div>
              <p className="mt-0.5 text-[11.5px] leading-snug text-faint">
                {r.rationale}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Data-quality issues — what a human must fix */}
      {data.issues.length > 0 && (
        <section className="space-y-2">
          <Eyebrow>Fix before activating</Eyebrow>
          <ul className="space-y-1.5">
            {data.issues.map((iss, i) => (
              <li
                key={i}
                className="flex gap-2 rounded-xl bg-warn-soft/70 px-3 py-2 text-[11.5px] leading-snug text-ink ring-1 ring-inset ring-warn-line/60"
              >
                <span className="mt-px shrink-0 text-warn">⚠</span>
                <span>{iss.note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

/**
 * A representative workflow shown DIMMED behind the empty/running state, so the
 * canvas is never a blank box — the viewer sees the shape of the thing discovery
 * produces (a conditional gate DAG) before they run it. Sample data only; the real
 * one is derived from the client's org.
 */
const SAMPLE_WORKFLOW: ApprovalWorkflow = {
  name: "Sample approval workflow",
  roots: ["manager"],
  steps: [
    {
      id: "manager",
      kind: "approval",
      label: "Manager review",
      when: { kind: "always" },
      approverTitle: "Manager",
      approverName: "Riley Carter",
      next: ["director", "dept"],
    },
    {
      id: "director",
      kind: "approval",
      label: "Director review",
      when: { kind: "leaf", field: "amount", op: ">", value: 25000 },
      approverTitle: "CFO",
      approverName: "Cameron Diaz",
      next: ["post"],
    },
    {
      id: "dept",
      kind: "approval",
      label: "Department head",
      when: { kind: "leaf", field: "department", op: "==", value: "IT" },
      approverTitle: "COO",
      approverName: "Jordan Ellis",
      next: ["post"],
    },
    {
      id: "post",
      kind: "integration",
      label: "Post to NetSuite",
      when: { kind: "always" },
      integration: "netsuite",
      next: [],
    },
  ],
};

const EmptyState = ({ running }: { running: boolean }) => {
  return (
    <div className="relative h-full min-h-72 overflow-hidden rounded-xl bg-subtle/40 ring-1 ring-inset ring-line">
      {/* The sample workflow, dimmed — gives the canvas real structure instead of
          a hollow box. Non-interactive (pointer-events-none). */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] blur-[1px]">
        <WorkflowGraph workflow={SAMPLE_WORKFLOW} />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-surface/40 via-transparent to-surface/40" />

      {/* The caption sits over the dimmed graph. */}
      <div className="absolute inset-0 grid place-items-center px-8 text-center">
        <div className="max-w-sm space-y-2.5">
          {running ? (
            <>
              <div className="mx-auto flex items-center justify-center gap-2 text-[13px] font-medium text-ink">
                <Spinner /> Reading the org &amp; deriving the workflow…
              </div>
              <p className="text-[12px] text-muted">
                The agent resolves each gate to a real person from the chart.
              </p>
            </>
          ) : (
            <>
              <p className="text-[14px] font-semibold text-ink">
                No workflow yet
              </p>
              <p className="text-[12.5px] leading-relaxed text-muted">
                Run discovery and the agent derives a conditional approval
                workflow like this from the client&apos;s org chart, resolved to
                real approvers and ready to edit in plain language.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/** The at-rest left pane: a compact preview of what discovery will produce, so
    the pane carries content before a run instead of a lone button. */
const DiscoveryPreview = ({ running }: { running: boolean }) => {
  const items = [
    {
      title: "Read the org chart",
      body: "Pull every active employee, their title, and who they report to.",
    },
    {
      title: "Resolve approvers",
      body: "Map each approval gate to a real person, not a placeholder role.",
    },
    {
      title: "Flag data issues",
      body: "Surface orphans, missing managers, and junk records to fix first.",
    },
  ];
  return (
    <div className={running ? "opacity-50" : ""}>
      <Eyebrow className="mb-2">What discovery produces</Eyebrow>
      <ol className="space-y-1.5">
        {items.map((it, i) => (
          <li
            key={it.title}
            className="flex gap-3 rounded-lg bg-subtle/60 px-3 py-2.5 ring-1 ring-inset ring-line"
          >
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface text-[11px] font-semibold text-muted ring-1 ring-inset ring-line-strong">
              {i + 1}
            </span>
            <span>
              <span className="block text-[12.5px] font-semibold text-ink">
                {it.title}
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">
                {it.body}
              </span>
            </span>
          </li>
        ))}
      </ol>
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
