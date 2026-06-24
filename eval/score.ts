import type { Investigation } from "@/lib/schema";

/**
 * Pure scoring for the investigator eval — no I/O, unit-tested.
 *
 * Two views, because "accuracy" alone hides the failure that matters in AP:
 *   • overall accuracy — did the recommendation match the expected label?
 *   • overcharge precision / recall — treating "likely_overcharge" as the
 *     positive class. Recall = of the invoices that SHOULD be pushed back on, how
 *     many did the agent catch; precision = of the ones it flagged, how many were
 *     real. Missing a real overcharge (low recall) is the expensive error.
 */

export type Recommendation = Investigation["recommendation"];

export type CaseScore = {
  id: string;
  stresses: string;
  expected: Recommendation;
  /** undefined when the agent produced nothing / errored (a hard failure). */
  got: Recommendation | undefined;
  correct: boolean;
  failed?: string;
};

export type Confusion = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
};

const POSITIVE: Recommendation = "likely_overcharge";

/** Score one case: did `got` match `expected`? */
export function scoreCase(
  id: string,
  stresses: string,
  expected: Recommendation,
  got: Recommendation | undefined,
  failed?: string,
): CaseScore {
  return {
    id,
    stresses,
    expected,
    got,
    correct: got !== undefined && got === expected,
    failed,
  };
}

/** Overall accuracy across the scored cases (failed cases count as incorrect). */
export function accuracy(scores: CaseScore[]): number {
  if (scores.length === 0) return 0;
  const correct = scores.filter((s) => s.correct).length;
  return correct / scores.length;
}

/**
 * Precision / recall / F1 for the "likely_overcharge" positive class.
 *   TP — expected overcharge, got overcharge
 *   FP — got overcharge, expected something else
 *   FN — expected overcharge, got something else (or failed)
 */
export function overchargeConfusion(scores: CaseScore[]): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of scores) {
    const gotPos = s.got === POSITIVE;
    const expPos = s.expected === POSITIVE;
    if (expPos && gotPos) tp++;
    else if (!expPos && gotPos) fp++;
    else if (expPos && !gotPos) fn++;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
  };
}
