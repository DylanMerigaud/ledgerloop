import { z } from "zod";

/**
 * A CLIENT PROFILE — the config that makes the pipeline behave differently per
 * customer, without touching code. This is what onboarding a client comes down
 * to: not a custom build, but filling in this profile.
 *
 * Today the profile holds the matching tolerances and the approval policy (the
 * thresholds that used to be hard-coded in `lib/matching.ts` / `lib/policy.ts`).
 * The onboarding discovery agent will eventually PRODUCE these (deriving the
 * approval tiers from the client's org chart, the ERP mapping from their
 * NetSuite), validated by a human; the pipeline CONSUMES them. One profile in,
 * the whole P2P flow adapts. See `.product/` for the architecture.
 *
 * Defaults mirror the values the demo shipped with, so a profile is optional
 * everywhere — pass one to customise, omit it for the standard behaviour.
 */

/** Tolerances below which a variance is rounding noise, not a real exception. */
export const MatchTolerances = z
  .object({
    /** Relative unit-price tolerance (e.g. 0.01 = 1%). */
    pricePct: z.number().min(0),
    /** Absolute per-line tolerance for the amount = qty × price check. */
    lineAmountAbs: z.number().min(0),
    /** Quantity tolerance (0 = exact; you either received the units or you didn't). */
    qtyAbs: z.number().min(0),
  })
  .strict();
export type MatchTolerances = z.infer<typeof MatchTolerances>;

/** A single approval tier: the money/variance at or above which it kicks in. */
const ApprovalTier = z
  .object({
    amount: z.number().min(0),
    variancePct: z.number().min(0),
  })
  .strict();

/** When an exception needs a human, which tier owns it (by money + variance). */
export const ApprovalPolicy = z
  .object({
    manager: ApprovalTier,
    director: ApprovalTier,
  })
  .strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

/** The full per-client config the pipeline runs under. */
export const ClientProfile = z
  .object({
    /** Stable client id (e.g. "severn-manufacturing"). */
    id: z.string().trim().min(1),
    /** Human label for the queue / UI. */
    name: z.string().trim().min(1),
    tolerances: MatchTolerances,
    approvalPolicy: ApprovalPolicy,
  })
  .strict();
export type ClientProfile = z.infer<typeof ClientProfile>;

/* ── Defaults — the values the demo shipped with ────────────────────────────
   Used wherever a profile isn't supplied, so existing call sites (tests, the
   sanity check) keep their exact behaviour. */

export const DEFAULT_TOLERANCES: MatchTolerances = {
  pricePct: 0.01, // 1% — absorbs FX/rounding without hiding real overcharges
  lineAmountAbs: 0.01,
  qtyAbs: 0,
};

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  manager: { amount: 1_000, variancePct: 0.05 },
  director: { amount: 10_000, variancePct: 0.1 },
};
