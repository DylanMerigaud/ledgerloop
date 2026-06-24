import type { MatchResult, ApprovalDecision, ApproverTier } from "./schema";
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from "./client-profile";

/**
 * Approval routing policy — pure, deterministic, unit-tested.
 *
 * After matching, an invoice needs to be ROUTED: a clean match can go straight
 * through (no human), but an exception has to climb an approval ladder whose
 * height depends on how much money and how large a variance are at stake. This
 * is the business-rule half of the workflow's conditional branching — the
 * approval workflow step calls `routeApproval` directly. Deterministic: the tier
 * is policy, not a judgment call for a model.
 *
 * Thresholds are deliberately simple and legible so the routing is explainable
 * on a sales call ("a 7% overcharge on a $30k line jumps straight to director").
 */

/* The thresholds now come from the client profile (`lib/client-profile.ts`) so a
   strict manufacturer and a loose distributor can route differently without code
   changes. `routeApproval` takes the policy as a parameter, defaulting to the
   standard tiers. */

/** Decide the approver tier from the money + variance at stake. */
function tierFor(
  exceptionAmount: number,
  maxVariancePct: number,
  policy: ApprovalPolicy,
): ApproverTier {
  if (
    exceptionAmount >= policy.director.amount ||
    maxVariancePct >= policy.director.variancePct
  ) {
    return "director";
  }
  if (
    exceptionAmount >= policy.manager.amount ||
    maxVariancePct >= policy.manager.variancePct
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
export function routeApproval(
  match: MatchResult,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): ApprovalDecision {
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
  const tier = tierFor(match.exceptionAmount, match.maxVariancePct, policy);
  const drivers: string[] = [];
  if (match.exceptionAmount > 0)
    drivers.push(`${money(match.exceptionAmount, match.currency)} at stake`);
  if (match.maxVariancePct > 0)
    drivers.push(`${pct(match.maxVariancePct)} max variance`);
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
