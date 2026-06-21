import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCase,
  accuracy,
  overchargeConfusion,
  type CaseScore,
} from "./score";

/** Build a scored case quickly. */
function sc(
  expected: CaseScore["expected"],
  got: CaseScore["got"],
  failed?: string,
): CaseScore {
  return scoreCase("X", "stress", expected, got, failed);
}

test("scoreCase marks a match correct and a mismatch incorrect", () => {
  assert.equal(sc("likely_overcharge", "likely_overcharge").correct, true);
  assert.equal(sc("likely_overcharge", "likely_legitimate").correct, false);
});

test("a failed case (got undefined) is incorrect", () => {
  const s = sc("likely_overcharge", undefined, "no text");
  assert.equal(s.correct, false);
  assert.equal(s.failed, "no text");
});

test("accuracy is the fraction correct", () => {
  const scores = [
    sc("likely_overcharge", "likely_overcharge"),
    sc("likely_legitimate", "likely_legitimate"),
    sc("unclear", "likely_overcharge"),
    sc("likely_overcharge", undefined),
  ];
  assert.equal(accuracy(scores), 0.5); // 2 of 4
  assert.equal(accuracy([]), 0);
});

test("overcharge confusion: TP / FP / FN counted on the positive class", () => {
  const scores = [
    sc("likely_overcharge", "likely_overcharge"), // TP
    sc("likely_legitimate", "likely_overcharge"), // FP
    sc("likely_overcharge", "unclear"), // FN
    sc("likely_overcharge", undefined), // FN (failed)
    sc("likely_legitimate", "likely_legitimate"), // TN (ignored)
  ];
  const c = overchargeConfusion(scores);
  assert.equal(c.truePositives, 1);
  assert.equal(c.falsePositives, 1);
  assert.equal(c.falseNegatives, 2);
  assert.equal(c.precision, 0.5); // 1 / (1+1)
  assert.equal(Number(c.recall.toFixed(4)), 0.3333); // 1 / (1+2)
});

test("perfect predictions → precision/recall/F1 = 1", () => {
  const scores = [
    sc("likely_overcharge", "likely_overcharge"),
    sc("likely_legitimate", "likely_legitimate"),
    sc("unclear", "unclear"),
  ];
  const c = overchargeConfusion(scores);
  assert.equal(c.precision, 1);
  assert.equal(c.recall, 1);
  assert.equal(c.f1, 1);
  assert.equal(accuracy(scores), 1);
});

test("no positives at all → precision/recall default to 1 (nothing to get wrong)", () => {
  const scores = [sc("likely_legitimate", "likely_legitimate")];
  const c = overchargeConfusion(scores);
  assert.equal(c.precision, 1);
  assert.equal(c.recall, 1);
});
