"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  BambooHrIcon,
  SlackIcon,
  NetSuiteIcon,
  JiraIcon,
} from "@/components/ui/brand-icon";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, Eyebrow } from "@/components/ui/card";
import { WorkflowEditor } from "@/components/workflow-editor";
import { WorkflowGraph } from "@/components/workflow-graph";
import type { ApprovalWorkflow } from "@/lib/approval-workflow";
import { orpc } from "@/lib/orpc/client";
import { type OnboardingResult, type OrgEmployee } from "@/lib/orpc/schemas";

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

// The onboarding response shape lives in the shared oRPC schema (one definition for
// server + client), imported as OnboardingResult.

type State =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; data: OnboardingResult };

export const Onboarding = ({
  onWorkflowChange,
}: {
  /** Push the active workflow up to AppView so the Pipeline tab runs against it:
      the derived one on discovery, then each approved edit from the editor. */
  onWorkflowChange: (workflow: ApprovalWorkflow) => void;
}) => {
  // Discovery is a TanStack Query mutation over the typed oRPC procedure. We map its
  // lifecycle to the screen's State machine so the rest of the JSX is unchanged.
  const [state, setState] = useState<State>({ status: "idle" });
  const discovery = useMutation(
    orpc.onboarding.mutationOptions({
      onMutate: () => setState({ status: "running" }),
      onSuccess: (data) => {
        setState({ status: "done", data });
        // The freshly derived workflow becomes the active one for the pipeline.
        onWorkflowChange(data.workflow);
      },
      onError: (err) =>
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Discovery failed.",
        }),
    }),
  );
  const discover = () => discovery.mutate({});

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
          {/* The pitch is only useful BEFORE a run — once results are in, it just
              repeats what the panel now shows, so drop it. */}
          {state.status !== "done" && (
            <p className="text-[13px] leading-relaxed text-muted">
              Point the agent at the client&apos;s HR system. It reads the org
              chart, derives who signs off on what (resolved to real people),
              and flags the data issues to fix before going live.
            </p>
          )}
          <div>
            <Button onClick={discover} loading={state.status === "running"}>
              {state.status === "running" ? (
                "Reading org…"
              ) : state.status === "done" ? (
                "Re-run discovery"
              ) : (
                <>
                  <BambooHrIcon size={15} />
                  Discover from BambooHR
                </>
              )}
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
          {state.status === "done" && <WhatCanIChange />}
        </CardHeader>
        <div className="flex-1 overflow-hidden p-5">
          {state.status === "done" ? (
            // Key by the discovered workflow so a re-run resets the editor state.
            <WorkflowEditor
              key={state.data.workflow.name + state.data.employeeCount}
              initial={state.data.workflow}
              suggestions={state.data.suggestions}
              onCurrentChange={onWorkflowChange}
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
 * A clickable "What can I change?" helper that opens a popover listing the edits
 * the plain-language editor actually supports — so the capabilities are
 * discoverable without overclaiming. (The editor maps your sentence to one of
 * these structured ops; it's natural-language editing, not an open-ended agent.)
 */
const EDIT_ACTIONS: {
  icon: React.ReactNode;
  title: string;
  example: string;
}[] = [
  {
    icon: <span className="text-[11px]">✓</span>,
    title: "Add an approval gate",
    example: "“Require a CFO sign-off above $50k”",
  },
  {
    icon: <SlackIcon size={14} />,
    title: "Add a Slack notification",
    example: "“Notify on Slack when a bill posts”",
  },
  {
    icon: <JiraIcon size={14} />,
    title: "Open a Jira ticket",
    example: "“Open a Jira ticket for Product bills”",
  },
  {
    icon: <NetSuiteIcon size={14} />,
    title: "Post to NetSuite",
    example: "“Post approved bills to NetSuite”",
  },
  {
    icon: <span className="text-[11px]">$</span>,
    title: "Change a threshold",
    example: "“Lower the director threshold to $10k”",
  },
  {
    icon: <span className="text-[11px]">@</span>,
    title: "Change an approver",
    example: "“Make Jordan Ellis the director approver”",
  },
  {
    icon: <span className="text-[11px]">−</span>,
    title: "Remove a step",
    example: "“Drop the department review”",
  },
];

const WhatCanIChange = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target;
      if (
        target instanceof Node &&
        ref.current &&
        !ref.current.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 text-[11.5px] font-medium text-muted ring-1 ring-inset ring-line-strong transition-colors hover:text-ink"
      >
        <span className="grid size-3.5 place-items-center rounded-full bg-ink text-[9px] font-bold text-white">
          ?
        </span>
        What can I change?
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl bg-surface p-2 shadow-lift ring-1 ring-inset ring-line">
          <p className="px-2 pb-1.5 pt-1 text-[11px] leading-snug text-faint">
            Describe a change in plain language; it proposes a rewrite and you
            review the diff before anything applies.
          </p>
          <ul className="space-y-0.5">
            {EDIT_ACTIONS.map((a) => (
              <li
                key={a.title}
                className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-subtle"
              >
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-subtle text-muted ring-1 ring-inset ring-line-strong">
                  {a.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-ink">
                    {a.title}
                  </span>
                  <span className="block text-[11px] italic leading-snug text-faint">
                    {a.example}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/** Initials for an avatar chip ("Riley Carter" → "RC"). */
const initials = (name: string): string =>
  name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

/**
 * The org as a reporting tree (roots at top, reports nested under a guide rail),
 * with flagged people marked by a warn ring on their avatar — so a viewer can see
 * the data issues against the real chart (the junk record, the orphan with no
 * manager) instead of just a count. Scrolls inside a capped box so a real 90-person
 * org doesn't push the rest of the panel off screen.
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

  const renderNodes = (parent: string | null): React.ReactNode => {
    const nodes = childrenOf.get(parent) ?? [];
    return nodes.map((e) => {
      const isFlagged = flagged.has(e.id);
      const children = renderNodes(e.id);
      return (
        <div key={e.id}>
          <div className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface">
            <span
              className={`grid size-[22px] shrink-0 place-items-center rounded-full text-[9px] font-semibold ${
                isFlagged
                  ? "bg-warn-soft text-warn ring-1 ring-inset ring-warn-line"
                  : "bg-surface text-muted ring-1 ring-inset ring-line-strong"
              }`}
            >
              {initials(e.name)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="text-[12px] font-medium text-ink">{e.name}</span>
              <span className="ml-1 text-[11px] text-faint">
                {e.title || "(no title)"}
              </span>
            </span>
            {isFlagged && (
              <span className="shrink-0 text-[11px] text-warn" title="flagged">
                ⚠
              </span>
            )}
          </div>
          {/* reports nest under a guide rail, not ASCII connectors */}
          {children && (
            <div className="ml-[10px] border-l border-line pl-3">
              {children}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="scrollbar-slim max-h-72 space-y-0.5 overflow-y-auto">
      {renderNodes(null)}
    </div>
  );
};

const DiscoverySummary = ({ data }: { data: OnboardingResult }) => {
  const resolved = data.proposal.roles.filter((r) => r.employeeName).length;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="ok">{data.employeeCount} employees</Badge>
        <Badge tone="neutral">
          {resolved}/{data.proposal.roles.length} approvers resolved
        </Badge>
        {data.issues.length > 0 && (
          <Badge tone="warn">{data.issues.length} to fix</Badge>
        )}
      </div>

      {/* (The agent's prose summary was dropped — it duplicated the workflow on the
          right and the resolved-approvers + issues already shown below.) */}

      {/* The org the agent read — flagged people marked against the real chart. */}
      <section className="space-y-2">
        <Eyebrow>Org chart · {data.employees.length} people</Eyebrow>
        <OrgTree employees={data.employees} issues={data.issues} />
      </section>

      {/* Role resolutions — the fuzzy work the agent did. Rationale behind a
          per-row disclosure so the list reads cleanly by default. */}
      <section className="space-y-2">
        <Eyebrow>Approvers resolved from the org</Eyebrow>
        <div className="space-y-1.5">
          {data.proposal.roles.map((r) => (
            <details
              key={r.role}
              className="group rounded-lg bg-surface ring-1 ring-inset ring-line [&_summary]:list-none"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2">
                <span className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold capitalize text-ink">
                    {r.role.replace("-", " ")}
                  </span>
                  <Chevron />
                </span>
                <span className="text-[12px] font-medium text-muted">
                  {r.employeeName ?? (
                    <span className="text-warn">unresolved</span>
                  )}
                </span>
              </summary>
              <p className="border-t border-line px-3 py-2 text-[11.5px] leading-snug text-faint">
                {r.rationale}
              </p>
            </details>
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
                className="flex gap-2 rounded-lg bg-warn-soft/60 px-3 py-2 text-[11.5px] leading-snug text-ink ring-1 ring-inset ring-warn-line/50"
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

/** A small chevron that rotates when its parent <details> is open. */
const Chevron = () => {
  return (
    <svg
      viewBox="0 0 12 12"
      className="size-3 text-faint transition-transform group-open:rotate-90"
      fill="none"
      aria-hidden
    >
      <path
        d="m4.5 3 3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
      when: { kind: "leaf", field: "department", op: "==", value: "Product" },
      approverTitle: "VP of Product",
      approverName: "Sam Patel",
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
