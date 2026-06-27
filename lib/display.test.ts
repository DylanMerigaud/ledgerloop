import assert from "node:assert/strict";
import { test } from "node:test";

import { SEED_BUNDLES } from "@/db/seed-data";
import { scenarioKind, scenarioBadge } from "@/lib/display";

/**
 * The queue signposting helpers — what marks a seeded row BEFORE it's run, so a
 * first-time visitor's eye lands on the interesting cases. Classification is
 * derived from the scenario label; these pin that every seeded scenario lands in
 * the right bucket (a mislabel would mark a clean row as an exception, or hide a
 * blocked one).
 */

test("classifies the variance/control scenarios as exceptions", () => {
  for (const s of [
    "Price mismatch",
    "Quantity mismatch",
    "Arithmetic error",
    "Line not on PO",
    "Inactive vendor (ERP)",
  ]) {
    assert.equal(scenarioKind(s), "exception", s);
  }
});

test("classifies the duplicate scenarios as blocked", () => {
  assert.equal(scenarioKind("Duplicate invoice"), "blocked");
  assert.equal(scenarioKind("Already paid (ERP duplicate)"), "blocked");
});

test("classifies clean matches (and the paid original) as clean", () => {
  for (const s of [
    "Clean 3-way match",
    "Clean 2-way (services)",
    "Original (paid)",
    null,
  ]) {
    assert.equal(scenarioKind(s), "clean", String(s));
  }
});

test("scenarioBadge marks exception (warn) and blocked (danger), not clean", () => {
  assert.deepEqual(scenarioBadge("exception"), {
    tone: "warn",
    label: "exception",
  });
  assert.deepEqual(scenarioBadge("blocked"), {
    tone: "danger",
    label: "blocked",
  });
  // Clean rows stay unmarked, so the marks draw the eye.
  assert.equal(scenarioBadge("clean"), null);
});

test("every seeded scenario classifies without falling through wrongly", () => {
  // A guard against a future seed label that the classifier would silently treat
  // as clean when it's actually an exception/blocked. We assert the known kinds
  // line up with the labels the demo depends on.
  const byId = new Map(SEED_BUNDLES.map((b) => [b.id, b.scenario]));
  assert.equal(scenarioKind(byId.get("INV-2042") ?? null), "exception"); // price
  assert.equal(scenarioKind(byId.get("INV-2048") ?? null), "exception"); // qty
  assert.equal(scenarioKind(byId.get("INV-1990") ?? null), "blocked"); // already paid
  assert.equal(scenarioKind(byId.get("INV-2040") ?? null), "clean"); // clean 3-way
});
