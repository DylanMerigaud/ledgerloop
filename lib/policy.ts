import type { MatchResult, ApprovalDecision, ApproverTier } from "./schema";

/**
 * Approval routing policy — pure, deterministic, unit-tested.
 *
 * After matching, an invoice needs to be ROUTED: a clean match can go straight
 * through (no human), but an exception has to climb an approval ladder whose
 * height depends on how much money and how large a variance are at stake. This
 * is the business-rule half of the workflow's conditional branching — the
 * Approval agent calls `routeApproval` through a tool and narrates the outcome.
 *
 * Thresholds are deliberately simple and legible so the routing is explainable
 * on a sales call ("a 7% overcharge on a $30k line jumps straight to director").
 */

const APPROVAL_POLICY = {
  /** Manager sign-off kicks in above this exposure or variance. */
  manager: {
    amount: 1_000, // money at stake on exception lines, in the invoice currency
    variancePct: 0.05, // 5%
  },
  /** Director sign-off for material exposure or large variances. */
  director: {
    amount: 10_000,
    variancePct: 0.1, // 10%
  },
} as const;

/** Decide the approver tier from the money + variance at stake. */
function tierFor(exceptionAmount: number, maxVariancePct: number): ApproverTier {
  if (
    exceptionAmount >= APPROVAL_POLICY.director.amount ||
    maxVariancePct >= APPROVAL_POLICY.director.variancePct
  ) {
    return "director";
  }
  if (
    exceptionAmount >= APPROVAL_POLICY.manager.amount ||
    maxVariancePct >= APPROVAL_POLICY.manager.variancePct
  ) {
    return "manager";
  }
  // An exception exists but it's small on both axes — a manager still owns it
  // (we never auto-approve a real variance), but it's the lowest human tier.
  return "manager";
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function money(n: number, currency: string): string {
  const v = Math.round((n + Number.EPSILON) * 100) / 100;
  return `${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

/**
 * Route a matched invoice to the correct approval tier.
 *
 *   verdict "duplicate" → "blocked"  (control failure; do not pay)
 *   verdict "clean"     → "auto"     (straight-through processing, no human)
 *   verdict "exception" → manager | director  (by money + variance)
 */
export function routeApproval(match: MatchResult): ApprovalDecision {
  const base = {
    invoiceNumber: match.invoiceNumber,
    maxVariancePct: match.maxVariancePct,
    exceptionAmount: match.exceptionAmount,
    currency: match.currency,
  };

  if (match.verdict === "duplicate") {
    return {
      ...base,
      tier: "blocked",
      autoApproved: false,
      reason: `Blocked: ${match.invoiceNumber} is a duplicate of an already-processed invoice. No approval routing — flag for AP review.`,
    };
  }

  if (match.verdict === "clean") {
    return {
      ...base,
      tier: "auto",
      autoApproved: true,
      reason: `Clean ${match.matchType === "three_way" ? "3-way" : "2-way"} match within tolerance — auto-approved for straight-through processing.`,
    };
  }

  // exception → tiered human approval
  const tier = tierFor(match.exceptionAmount, match.maxVariancePct);
  const drivers: string[] = [];
  if (match.exceptionAmount > 0) drivers.push(`${money(match.exceptionAmount, match.currency)} at stake`);
  if (match.maxVariancePct > 0) drivers.push(`${pct(match.maxVariancePct)} max variance`);
  const driverText = drivers.length ? drivers.join(", ") : "policy exception";

  return {
    ...base,
    tier,
    autoApproved: false,
    reason: `Routed to ${tier} approval (${match.exceptions.length} exception${
      match.exceptions.length === 1 ? "" : "s"
    }: ${driverText}).`,
  };
}
