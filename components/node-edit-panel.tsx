"use client";

import { useState } from "react";

import { ConditionEditor } from "@/components/condition-editor";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import type { ApprovalWorkflow, WorkflowStep } from "@/lib/approval-workflow";
import type { AvailableValues } from "@/lib/condition-fields";
import type { OrgEmployee } from "@/lib/orpc/schemas";
import { applyEditOp, type WorkflowEditOp } from "@/lib/workflow-edit";
import { validateWorkflow, isActivatable } from "@/lib/workflow-validate";

/**
 * The node editor — click a gate in the graph (onboarding only) and this side panel
 * edits THAT step directly, the Pivot/Retool pattern. Every change is deterministic:
 * it builds one `WorkflowEditOp` and the parent applies it with `applyEditOp`
 * immediately (no model, no preview/approve cycle — the chat handles fuzzy intent;
 * this handles precise, unambiguous edits). Fields: approver, the full trigger
 * (the condition editor), label, remove.
 */

/** Order the org for the approver picker: titles closest to the gate's role first
    (a "Director" gate surfaces VPs / C-level), then everyone else, by name. */
const peopleFor = (people: OrgEmployee[], role: string): OrgEmployee[] => {
  const r = role.toLowerCase();
  const relevant = (p: OrgEmployee): boolean => {
    const t = p.title.toLowerCase();
    if (!t) return false;
    // Share a word with the role, or both read as senior (VP / chief / head / director).
    const senior = /vp|chief|head|director|officer|controller/;
    return (
      r.split(/\s+/).some((w) => w.length > 2 && t.includes(w)) ||
      (senior.test(r) && senior.test(t))
    );
  };
  const score = (p: OrgEmployee): number => (relevant(p) ? 0 : 1);
  return [...people].sort(
    (a, b) => score(a) - score(b) || a.name.localeCompare(b.name),
  );
};

/** A person row for the approver combobox: initials avatar + name + title. */
const PersonRow = ({ name, title }: { name: string; title: string }) => {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-accent-soft text-[8px] font-semibold uppercase text-accent">
        {initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
        {name}
        {title && <span className="text-faint"> · {title}</span>}
      </span>
    </span>
  );
};

export const NodeEditPanel = ({
  workflow,
  stepId,
  people,
  available,
  onApply,
  onClose,
}: {
  workflow: ApprovalWorkflow;
  stepId: string;
  people: OrgEmployee[];
  available: AvailableValues;
  onApply: (op: WorkflowEditOp) => void;
  onClose: () => void;
}) => {
  const step = workflow.steps.find((s) => s.id === stepId);
  if (!step) return null;
  return (
    <PanelShell title={step.label} onClose={onClose}>
      {step.kind === "approval" ? (
        <ApprovalFields
          step={step}
          people={people}
          available={available}
          onApply={onApply}
        />
      ) : (
        <p className="text-[12px] text-faint">
          A system step (posts the bill / notifies). Rename or remove it below.
        </p>
      )}
      <LabelField step={step} onApply={onApply} />
      <RemoveField
        workflow={workflow}
        stepId={stepId}
        onApply={onApply}
        onClose={onClose}
      />
    </PanelShell>
  );
};

const ApprovalFields = ({
  step,
  people,
  available,
  onApply,
}: {
  step: Extract<WorkflowStep, { kind: "approval" }>;
  people: OrgEmployee[];
  available: AvailableValues;
  onApply: (op: WorkflowEditOp) => void;
}) => {
  const ordered = peopleFor(people, step.approverTitle);
  const unresolved = step.approverName === null;
  const optionsFor = (taken: string[]): ComboboxOption[] =>
    ordered
      .filter((p) => !taken.includes(p.name))
      .map((p) => ({
        value: p.name,
        label: p.name,
        sublabel: p.title || undefined,
        keywords: `${p.title} ${p.department}`,
        render: () => <PersonRow name={p.name} title={p.title} />,
      }));

  const extras = step.approvers ?? [];
  const setExtras = (next: string[]) =>
    onApply({ op: "set-approvers", stepId: step.id, approvers: next });

  return (
    <>
      <Field label={`Approver · ${step.approverTitle}`}>
        <Combobox
          value={step.approverName ?? ""}
          onChange={(name) =>
            onApply({ op: "set-approver", stepId: step.id, approverName: name })
          }
          options={optionsFor(extras)}
          placeholder={unresolved ? "⚠ Choose a person…" : "Choose a person…"}
          invalid={unresolved}
          testid="approver-combobox"
        />
      </Field>

      <Field label="Also requires">
        {extras.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {extras.map((name) => (
              <span
                key={name}
                data-testid={`extra-approver-${name}`}
                className="inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2 pr-1 text-[11.5px] font-medium text-accent"
              >
                {name}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => setExtras(extras.filter((n) => n !== name))}
                  className="grid size-4 place-items-center rounded-full text-accent/70 hover:bg-accent/10 hover:text-accent"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <Combobox
          value=""
          onChange={(name) => name && setExtras([...extras, name])}
          options={optionsFor([
            ...(step.approverName ? [step.approverName] : []),
            ...extras,
          ])}
          placeholder="Add another approver…"
          testid="add-approver-combobox"
        />
      </Field>

      <Field label="Triggers when">
        <ConditionEditor
          value={step.when}
          available={available}
          onChange={(when) =>
            onApply({ op: "set-condition", stepId: step.id, when })
          }
        />
      </Field>
    </>
  );
};

const LabelField = ({
  step,
  onApply,
}: {
  step: WorkflowStep;
  onApply: (op: WorkflowEditOp) => void;
}) => {
  const [label, setLabel] = useState(step.label);
  return (
    <Field label="Label">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = label.trim();
          if (v && v !== step.label)
            onApply({ op: "rename-step", stepId: step.id, label: v });
        }}
        className="flex items-center gap-1.5"
      >
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-9 flex-1 rounded-lg bg-surface px-2.5 text-[13px] text-ink outline-none ring-1 ring-inset ring-line-strong transition-shadow focus:ring-2 focus:ring-accent-ring"
        />
        <Button type="submit" size="sm" variant="ghost">
          Rename
        </Button>
      </form>
    </Field>
  );
};

const RemoveField = ({
  workflow,
  stepId,
  onApply,
  onClose,
}: {
  workflow: ApprovalWorkflow;
  stepId: string;
  onApply: (op: WorkflowEditOp) => void;
  onClose: () => void;
}) => {
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    if (!window.confirm("Remove this step from the workflow?")) return;
    // Guard: a removal that breaks the graph (post unreachable, a dangling edge) is
    // refused — the validator is the same one the editor blocks Approve on.
    const after = applyEditOp(workflow, { op: "remove-step", stepId });
    if (!isActivatable(validateWorkflow(after))) {
      setError(
        "Can't remove this — it would break the workflow (nothing would post).",
      );
      return;
    }
    onApply({ op: "remove-step", stepId });
    onClose();
  };
  return (
    <div className="mt-1 border-t border-line pt-3">
      {error && (
        <p className="mb-2 text-[11.5px] leading-snug text-danger">{error}</p>
      )}
      <Button variant="danger" size="sm" onClick={remove}>
        Remove this step
      </Button>
    </div>
  );
};

/* ── shell + field chrome ────────────────────────────────────────────────────── */

const PanelShell = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) => (
  // Overlay on the right edge of the graph; the canvas stays full width behind it.
  // On a narrow screen it spans the bottom instead of a thin right column.
  <div className="absolute inset-x-0 bottom-0 z-20 max-h-[70%] overflow-y-auto rounded-t-xl bg-surface p-4 shadow-lift ring-1 ring-inset ring-line sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[320px] sm:rounded-l-xl sm:rounded-tr-none">
    <div className="mb-3 flex items-center justify-between gap-2">
      <span className="truncate text-[13px] font-semibold text-ink">
        {title}
      </span>
      <button
        onClick={onClose}
        aria-label="Close"
        className="grid size-6 shrink-0 place-items-center rounded-md text-faint ring-1 ring-inset ring-line-strong transition-colors hover:text-ink"
      >
        ×
      </button>
    </div>
    <div className="space-y-3">{children}</div>
  </div>
);

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div>
    <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-faint">
      {label}
    </span>
    {children}
  </div>
);
