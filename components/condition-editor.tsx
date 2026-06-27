"use client";

import { Combobox } from "@/components/ui/combobox";
import type {
  Condition,
  ConditionField,
  ConditionLeaf,
  ConditionOp,
} from "@/lib/approval-workflow";
import {
  CONDITION_FIELDS,
  defaultLeafFor,
  fieldMeta,
  type AvailableValues,
} from "@/lib/condition-fields";

/**
 * The condition editor — edits a gate's `when` as a 2-level ALL/ANY tree (the
 * Pivot/Retool filter pattern, kept to two levels: a root combinator holding leaves
 * plus ONE level of nested groups). The model supports arbitrary nesting and the engine
 * already evaluates it; this is the structural UI for it. Every change is deterministic
 * and rebuilds the whole tree immutably, then collapses to the canonical shape so the
 * stored `when` and its humanized chip stay clean.
 *
 * Field semantics (which ops, which value widget) come entirely from `condition-fields`,
 * so this component is declarative — adding a routing lever needs no change here.
 */

type Group = { kind: "all" | "any"; conditions: Condition[] };

/** A leaf or a (single-level) group — the two kinds of row in the root list. */
const isGroup = (c: Condition): c is Group =>
  c.kind === "all" || c.kind === "any";
const isLeaf = (c: Condition): c is ConditionLeaf => c.kind === "leaf";

/** Bring any stored condition into an editable root group (so there's always a
    combinator to toggle). `always` → empty ALL; a bare leaf → ALL of [leaf]. */
const normalize = (c: Condition): Group => {
  if (c.kind === "all" || c.kind === "any") return c;
  if (c.kind === "leaf") return { kind: "all", conditions: [c] };
  return { kind: "all", conditions: [] };
};

/** Collapse the edited root back to the canonical stored shape: empty → always; a
    single leaf under ALL → that leaf; otherwise the group (with empty subgroups
    dropped). Keeps `humanizeCondition` reading naturally and the schema minimal. */
const collapse = (root: Group): Condition => {
  const conditions = root.conditions.filter(
    (c) => !isGroup(c) || c.conditions.length > 0,
  );
  if (conditions.length === 0) return { kind: "always" };
  const only = conditions[0];
  if (conditions.length === 1 && only && !isGroup(only)) return only;
  return { kind: root.kind, conditions };
};

export const ConditionEditor = ({
  value,
  onChange,
  available,
}: {
  value: Condition;
  onChange: (next: Condition) => void;
  available: AvailableValues;
}) => {
  const root = normalize(value);
  const emit = (next: Group) => onChange(collapse(next));

  const setRow = (i: number, next: Condition) =>
    emit({
      ...root,
      conditions: root.conditions.map((c, j) => (j === i ? next : c)),
    });
  const removeRow = (i: number) =>
    emit({ ...root, conditions: root.conditions.filter((_, j) => j !== i) });
  const addLeaf = () =>
    emit({
      ...root,
      conditions: [...root.conditions, defaultLeafFor("amount", available)],
    });
  const addGroup = () =>
    emit({
      ...root,
      conditions: [
        ...root.conditions,
        { kind: "any", conditions: [defaultLeafFor("amount", available)] },
      ],
    });

  return (
    <div className="space-y-2 rounded-lg bg-subtle/30 p-2.5 ring-1 ring-inset ring-line">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-faint">Match</span>
        <Combinator
          kind={root.kind}
          onChange={(kind) => emit({ ...root, kind })}
        />
      </div>

      {root.conditions.length === 0 && (
        <p className="px-0.5 py-1 text-[11.5px] text-faint">
          No conditions — this gate fires on every invoice.
        </p>
      )}

      {root.conditions.map((c, i) =>
        isGroup(c) ? (
          <SubGroup
            key={i}
            group={c}
            available={available}
            onChange={(next) => setRow(i, next)}
            onRemove={() => removeRow(i)}
          />
        ) : isLeaf(c) ? (
          <LeafRow
            key={i}
            leaf={c}
            available={available}
            onChange={(next) => setRow(i, next)}
            onRemove={() => removeRow(i)}
          />
        ) : null,
      )}

      <div className="flex gap-1.5 pt-0.5">
        <AddButton testid="cond-add-leaf" onClick={addLeaf}>
          + condition
        </AddButton>
        <AddButton testid="cond-add-group" onClick={addGroup}>
          + group
        </AddButton>
      </div>
    </div>
  );
};

/** A nested group — leaves only (depth cap = 2, so no "+ group" inside). */
const SubGroup = ({
  group,
  available,
  onChange,
  onRemove,
}: {
  group: Group;
  available: AvailableValues;
  onChange: (next: Group) => void;
  onRemove: () => void;
}) => {
  const setLeaf = (i: number, next: Condition) =>
    onChange({
      ...group,
      conditions: group.conditions.map((c, j) => (j === i ? next : c)),
    });
  // Removing the last leaf removes the whole group (collapse drops empties anyway).
  const removeLeaf = (i: number) => {
    const conditions = group.conditions.filter((_, j) => j !== i);
    if (conditions.length === 0) onRemove();
    else onChange({ ...group, conditions });
  };
  const addLeaf = () =>
    onChange({
      ...group,
      conditions: [...group.conditions, defaultLeafFor("amount", available)],
    });

  return (
    <div className="space-y-2 rounded-lg bg-surface p-2 ring-1 ring-inset ring-line-strong">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-faint">Any/all of</span>
        <div className="flex items-center gap-1">
          <Combinator
            kind={group.kind}
            onChange={(kind) => onChange({ ...group, kind })}
          />
          <RemoveButton onClick={onRemove} label="Remove group" />
        </div>
      </div>
      {group.conditions.map((c, i) =>
        // A subgroup holds only leaves; ignore any deeper nesting defensively.
        isLeaf(c) ? (
          <LeafRow
            key={i}
            leaf={c}
            available={available}
            onChange={(next) => setLeaf(i, next)}
            onRemove={() => removeLeaf(i)}
          />
        ) : null,
      )}
      <AddButton testid="cond-subadd-leaf" onClick={addLeaf}>
        + condition
      </AddButton>
    </div>
  );
};

/** One comparison: field · op · value. Switching the field rebuilds a valid leaf. */
const LeafRow = ({
  leaf,
  available,
  onChange,
  onRemove,
}: {
  leaf: ConditionLeaf;
  available: AvailableValues;
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
}) => {
  const meta = fieldMeta(leaf.field, available);
  return (
    <div className="flex items-center gap-1">
      <select
        aria-label="Field"
        data-testid="cond-field"
        value={leaf.field}
        onChange={(e) =>
          onChange(defaultLeafFor(asField(e.target.value), available))
        }
        className={`${SELECT} min-w-0 flex-1`}
      >
        {CONDITION_FIELDS.map((f) => (
          <option key={f} value={f}>
            {fieldMeta(f, available).label}
          </option>
        ))}
      </select>

      <select
        aria-label="Operator"
        data-testid="cond-op"
        value={leaf.op}
        onChange={(e) => onChange({ ...leaf, op: asOp(e.target.value) })}
        className={`${SELECT} w-[52px] shrink-0 px-1 text-center`}
      >
        {meta.ops.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
      </select>

      <ValueInput leaf={leaf} meta={meta} onChange={onChange} />

      <RemoveButton onClick={onRemove} label="Remove condition" />
    </div>
  );
};

/** The value widget by field kind: a number input (money/pct aware), an enum select, or
    free text. variancePct stores a fraction (0.07) but shows a whole percent (7). */
const ValueInput = ({
  leaf,
  meta,
  onChange,
}: {
  leaf: ConditionLeaf;
  meta: ReturnType<typeof fieldMeta>;
  onChange: (next: ConditionLeaf) => void;
}) => {
  if (meta.kind === "enum" && meta.options) {
    const labelOf = (o: string) =>
      meta.label === "Exception flag" ? o.replace(/_/g, " ") : o;
    // Long lists (vendors, exception codes) get a searchable combobox; short enums
    // (verdict, matchType) stay a plain select — search there is overkill.
    if (meta.options.length > 6) {
      return (
        <div className="min-w-0 flex-1">
          <Combobox
            value={String(leaf.value)}
            onChange={(v) => onChange({ ...leaf, value: v })}
            options={meta.options.map((o) => ({ value: o, label: labelOf(o) }))}
            placeholder="Choose…"
            testid="cond-value"
            buttonClassName="h-8 text-[12px]"
          />
        </div>
      );
    }
    return (
      <select
        aria-label="Value"
        data-testid="cond-value"
        value={String(leaf.value)}
        onChange={(e) => onChange({ ...leaf, value: e.target.value })}
        className={`${SELECT} min-w-0 flex-1`}
      >
        {meta.options.map((o) => (
          <option key={o} value={o}>
            {labelOf(o)}
          </option>
        ))}
      </select>
    );
  }
  if (meta.kind === "number") {
    const shown =
      meta.unit === "pct" && typeof leaf.value === "number"
        ? Math.round(leaf.value * 100)
        : leaf.value;
    return (
      <div className="relative min-w-0 flex-1">
        {meta.unit === "money" && (
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-faint">
            $
          </span>
        )}
        <input
          type="number"
          aria-label="Value"
          data-testid="cond-value"
          value={shown}
          onChange={(e) => {
            const n = Number(e.target.value);
            const v = meta.unit === "pct" ? n / 100 : n;
            onChange({ ...leaf, value: Number.isFinite(v) ? v : 0 });
          }}
          className={`${INPUT} ${meta.unit === "money" ? "pl-5" : ""} ${
            meta.unit === "pct" ? "pr-6" : ""
          }`}
        />
        {meta.unit === "pct" && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-faint">
            %
          </span>
        )}
      </div>
    );
  }
  return (
    <input
      type="text"
      aria-label="Value"
      data-testid="cond-value"
      value={String(leaf.value)}
      onChange={(e) => onChange({ ...leaf, value: e.target.value })}
      className={`${INPUT} min-w-0 flex-1`}
    />
  );
};

/* ── small chrome ─────────────────────────────────────────────────────────────── */

const SELECT =
  "h-8 rounded-lg bg-surface px-1.5 text-[12px] text-ink outline-none ring-1 ring-inset ring-line-strong transition-shadow focus:ring-2 focus:ring-accent-ring";
const INPUT =
  "h-8 w-full rounded-lg bg-surface px-2 text-[12px] text-ink outline-none ring-1 ring-inset ring-line-strong transition-shadow focus:ring-2 focus:ring-accent-ring";

const Combinator = ({
  kind,
  onChange,
}: {
  kind: "all" | "any";
  onChange: (kind: "all" | "any") => void;
}) => (
  <select
    aria-label="Combinator"
    data-testid="cond-combinator"
    value={kind}
    onChange={(e) => onChange(e.target.value === "any" ? "any" : "all")}
    className={`${SELECT} w-[68px] font-medium`}
  >
    <option value="all">ALL</option>
    <option value="any">ANY</option>
  </select>
);

const AddButton = ({
  onClick,
  testid,
  children,
}: {
  onClick: () => void;
  testid: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    data-testid={testid}
    onClick={onClick}
    className="rounded-lg px-2 py-1 text-[11.5px] font-medium text-accent ring-1 ring-inset ring-line-strong transition-colors hover:bg-accent-soft"
  >
    {children}
  </button>
);

const RemoveButton = ({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-danger-soft hover:text-danger"
  >
    ✕
  </button>
);

/* The selects emit raw strings; narrow them back to the typed unions (the values come
   from our own option lists, so a non-match falls back to a safe default). */
const asField = (v: string): ConditionField =>
  CONDITION_FIELDS.find((f) => f === v) ?? "amount";
const ALL_OPS: ConditionOp[] = [">", ">=", "<", "<=", "==", "!="];
const asOp = (v: string): ConditionOp => ALL_OPS.find((o) => o === v) ?? "==";
