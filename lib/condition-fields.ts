import type {
  ConditionField,
  ConditionLeaf,
  ConditionOp,
} from "@/lib/approval-workflow";
import { MatchExceptionCode } from "@/lib/schema";

/**
 * Field metadata for the condition editor — the ONE place that knows how each routing
 * lever is edited (its value type, which operators make sense, and the fixed value
 * choices when it's an enum). The editor is purely declarative off this, the same way
 * `valueFor`/`humanizeLeaf` in approval-workflow centralize per-field logic for eval and
 * display. Adding a field is a single entry here.
 */

/** The values a leaf can be edited against that come from the run (not a fixed enum). */
export type AvailableValues = {
  departments: string[];
  vendors: string[];
  currencies: string[];
};

type FieldMeta = {
  label: string;
  /** How the value is entered. number → typed input; enum → a `<select>` of `options`;
      text → free text (the fallback when a "from the run" list is empty). */
  kind: "number" | "enum" | "text";
  /** Operators that are meaningful for this field (the editor constrains to these). */
  ops: ConditionOp[];
  /** A money/percent affordance on a number input (display only; pct stores a fraction). */
  unit?: "money" | "pct";
  /** Fixed choices for an enum field (exceptionCode/verdict/matchType). */
  options?: readonly string[];
  /** For enum fields whose choices come from the run, which AvailableValues list. */
  source?: keyof AvailableValues;
};

const COMPARE_OPS: ConditionOp[] = [">", ">=", "<", "<="];
const EQ_OPS: ConditionOp[] = ["==", "!="];

/** Static (run-independent) metadata per field. Run-sourced options are filled in by
    `fieldMeta` from AvailableValues. */
const STATIC_META: Record<ConditionField, FieldMeta> = {
  amount: { label: "Amount", kind: "number", ops: COMPARE_OPS, unit: "money" },
  exceptionAmount: {
    label: "Exception amount",
    kind: "number",
    ops: COMPARE_OPS,
    unit: "money",
  },
  variancePct: {
    label: "Variance %",
    kind: "number",
    ops: COMPARE_OPS,
    unit: "pct",
  },
  verdict: {
    label: "Verdict",
    kind: "enum",
    ops: EQ_OPS,
    options: ["clean", "exception", "duplicate"],
  },
  matchType: {
    label: "Match type",
    kind: "enum",
    ops: EQ_OPS,
    options: ["two_way", "three_way"],
  },
  exceptionCode: {
    label: "Exception flag",
    kind: "enum",
    ops: EQ_OPS,
    options: MatchExceptionCode.options,
  },
  department: {
    label: "Department",
    kind: "enum",
    ops: EQ_OPS,
    source: "departments",
  },
  vendor: { label: "Vendor", kind: "enum", ops: EQ_OPS, source: "vendors" },
  currency: {
    label: "Currency",
    kind: "enum",
    ops: EQ_OPS,
    source: "currencies",
  },
};

/** The fields offered in the editor, in a sensible order (the common levers first). */
export const CONDITION_FIELDS: ConditionField[] = [
  "amount",
  "department",
  "vendor",
  "currency",
  "verdict",
  "exceptionCode",
  "matchType",
  "exceptionAmount",
  "variancePct",
];

/**
 * The editable metadata for a field, with run-sourced enum options resolved from the
 * AVAILABLE values. A run-sourced field with no available values falls back to a free
 * text input (kind "text") so the gate can still be edited (and the chat-derived value
 * is preserved) before the queue has surfaced any value for it.
 */
export const fieldMeta = (
  field: ConditionField,
  available: AvailableValues,
): FieldMeta => {
  const meta = STATIC_META[field];
  if (meta.source) {
    const options = available[meta.source];
    return options.length > 0
      ? { ...meta, options }
      : { ...meta, kind: "text", options: undefined };
  }
  return meta;
};

/**
 * A valid leaf for a field the user just picked: the field's first operator and a
 * sensible default value (0 for numbers, the first enum option, "" for text). Keeps the
 * editor from ever producing an out-of-domain leaf when the field changes.
 */
export const defaultLeafFor = (
  field: ConditionField,
  available: AvailableValues,
): ConditionLeaf => {
  const meta = fieldMeta(field, available);
  const op = meta.ops[0] ?? "==";
  const value: string | number =
    meta.kind === "number" ? 0 : (meta.options?.[0] ?? "");
  return { kind: "leaf", field, op, value };
};
