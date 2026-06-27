import assert from "node:assert/strict";
import { test } from "node:test";

import { Condition } from "@/lib/approval-workflow";
import {
  CONDITION_FIELDS,
  defaultLeafFor,
  fieldMeta,
  type AvailableValues,
} from "@/lib/condition-fields";

/**
 * The editor is declarative off this metadata, so these pin the invariants the UI
 * relies on: every field yields a VALID leaf when picked (op in domain, value type
 * matches the widget), and run-sourced fields degrade to free text when the queue has
 * surfaced no values yet.
 */

const NONE: AvailableValues = { departments: [], vendors: [], currencies: [] };
const SOME: AvailableValues = {
  departments: ["Product", "Finance"],
  vendors: ["Forge Dev Tools"],
  currencies: ["USD", "EUR"],
};

test("defaultLeafFor yields a schema-valid leaf for every field", () => {
  for (const field of CONDITION_FIELDS) {
    const leaf = defaultLeafFor(field, SOME);
    // It parses as a Condition (so the op/value are in domain for the schema).
    assert.doesNotThrow(
      () => Condition.parse(leaf),
      `${field} leaf must validate`,
    );
    // The op is one the field actually allows.
    assert.ok(
      fieldMeta(field, SOME).ops.includes(leaf.op),
      `${field}: op ${leaf.op} not in its ops`,
    );
  }
});

test("number fields default to a numeric value, enum/text to a string", () => {
  assert.equal(typeof defaultLeafFor("amount", SOME).value, "number");
  assert.equal(typeof defaultLeafFor("variancePct", SOME).value, "number");
  assert.equal(typeof defaultLeafFor("verdict", SOME).value, "string");
  assert.equal(typeof defaultLeafFor("exceptionCode", SOME).value, "string");
});

test("enum fields carry options; exceptionCode uses the canonical code list", () => {
  const verdict = fieldMeta("verdict", SOME);
  assert.equal(verdict.kind, "enum");
  assert.deepEqual(verdict.options, ["clean", "exception", "duplicate"]);

  const code = fieldMeta("exceptionCode", SOME);
  assert.equal(code.kind, "enum");
  assert.ok(code.options?.includes("price_variance"));
  assert.ok(code.options?.includes("vendor_inactive"));
});

test("a run-sourced field uses available values, or falls back to text when empty", () => {
  const withValues = fieldMeta("department", SOME);
  assert.equal(withValues.kind, "enum");
  assert.deepEqual(withValues.options, ["Product", "Finance"]);

  const empty = fieldMeta("department", NONE);
  assert.equal(empty.kind, "text", "no departments → free text");
  assert.equal(empty.options, undefined);
});

test("a run-sourced field's default leaf picks the first available value", () => {
  assert.equal(defaultLeafFor("vendor", SOME).value, "Forge Dev Tools");
  // With no values it's text, default "" (still a valid leaf).
  assert.equal(defaultLeafFor("vendor", NONE).value, "");
});
