import { z } from "zod";
import {
  ApprovalWorkflow,
  type ApprovalWorkflow as TApprovalWorkflow,
  type WorkflowStep,
} from "./approval-workflow";

/**
 * A CLIENT PROFILE — the config that makes the pipeline behave differently per
 * customer, without touching code. This is what onboarding a client comes down
 * to: not a custom build, but filling in this profile.
 *
 * The profile holds the matching tolerances and the APPROVAL WORKFLOW — the
 * conditional DAG of who approves what under which conditions (lib/approval-
 * workflow.ts). The onboarding discovery agent derives the workflow from the
 * client's org chart, a human validates it, and the pipeline executes it. One
 * profile in, the whole P2P flow adapts. See `.product/` for the architecture.
 *
 * The legacy two-tier `approvalPolicy` is still here as the SOURCE the default
 * workflow is generated from (`workflowFromPolicy`), so a profile without an
 * explicit workflow still routes exactly as before — the DAG is a strict
 * superset of the old flat tiering.
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
    /** The legacy tier thresholds — the source the default workflow derives from. */
    approvalPolicy: ApprovalPolicy,
    /**
     * The conditional approval DAG. Optional: when absent, the pipeline derives a
     * behaviour-equivalent workflow from `approvalPolicy` via `workflowFromPolicy`,
     * so an un-onboarded profile still routes exactly as the old flat tiering did.
     * The onboarding agent fills this in for real.
     */
    workflow: ApprovalWorkflow.optional(),
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

/* ────────────────────────────────────────────────────────────────────────── *
 *  Bridge: the old flat tiering as a DAG
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * The conditional DAG is a strict superset of the two-tier policy, so we can
 * express the exact old behaviour as a workflow. This is what a profile without an
 * explicit (agent-derived) workflow runs, so the migration preserves behaviour:
 *
 *   • clean invoice  → both gates' conditions are false → straight to the post.
 *   • exception      → manager gate fires (verdict == exception); the director
 *                      gate additionally fires when the amount or variance clears
 *                      the director threshold (the old escalation rule).
 *   • duplicate      → handled as a pre-workflow control (blocked), never routed
 *                      here — a duplicate is a control failure, not an approval.
 */
export function workflowFromPolicy(
  policy: ApprovalPolicy,
  name = "Default approval workflow",
): TApprovalWorkflow {
  const isException: WorkflowStep["when"] = {
    kind: "leaf",
    field: "verdict",
    op: "==",
    value: "exception",
  };
  // Exception AND (amount >= director.amount OR variancePct >= director.variancePct).
  const directorEscalation: WorkflowStep["when"] = {
    kind: "all",
    conditions: [
      isException,
      {
        kind: "any",
        conditions: [
          {
            kind: "leaf",
            field: "amount",
            op: ">=",
            value: policy.director.amount,
          },
          {
            kind: "leaf",
            field: "variancePct",
            op: ">=",
            value: policy.director.variancePct,
          },
        ],
      },
    ],
  };

  const steps: WorkflowStep[] = [
    {
      id: "manager-review",
      kind: "approval",
      label: "Manager review",
      when: isException,
      approverTitle: "Manager",
      approverName: null,
      next: ["director-review", "post-netsuite"],
    },
    {
      id: "director-review",
      kind: "approval",
      label: "Director review",
      when: directorEscalation,
      approverTitle: "Director",
      approverName: null,
      next: ["post-netsuite"],
    },
    {
      id: "post-netsuite",
      kind: "integration",
      label: "Post to NetSuite",
      when: { kind: "always" },
      integration: "netsuite",
      next: [],
    },
  ];

  return { name, steps, roots: ["manager-review"] };
}

/** The workflow a profile runs: its explicit one, or the policy-derived default. */
export function workflowFor(profile: {
  approvalPolicy: ApprovalPolicy;
  workflow?: TApprovalWorkflow;
}): TApprovalWorkflow {
  return profile.workflow ?? workflowFromPolicy(profile.approvalPolicy);
}
