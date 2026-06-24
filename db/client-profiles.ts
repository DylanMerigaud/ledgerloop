import { nonNull } from "@/lib/assert";
import type { ClientProfile } from "@/lib/client-profile";
import {
  DEFAULT_TOLERANCES,
  DEFAULT_APPROVAL_POLICY,
} from "@/lib/client-profile";

/**
 * Seeded client profiles — the demo's stand-in for "onboarded customers". Each is
 * a different P2P configuration the SAME pipeline runs under, to show the
 * config-driven point: onboarding a client is filling in a profile, not a custom
 * build. (Eventually the onboarding agent PRODUCES these from a client's NetSuite
 * + org chart; for now they're seeded — see `.product/`.)
 *
 * Two deliberately different shapes:
 *   • a strict manufacturer — tight price tolerance, low approval thresholds
 *     (small overages escalate to a human, big ones to a director fast)
 *   • a relaxed distributor — loose tolerance, high thresholds (more goes
 *     straight through)
 * Run the same invoice under each and the verdict / approval tier differs — that's
 * the whole point.
 */

export const CLIENT_PROFILES: ClientProfile[] = [
  {
    id: "standard",
    name: "Standard",
    tolerances: DEFAULT_TOLERANCES,
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
  },
  {
    id: "severn-manufacturing",
    name: "Severn Manufacturing (strict)",
    tolerances: { pricePct: 0.005, lineAmountAbs: 0.01, qtyAbs: 0 },
    approvalPolicy: {
      manager: { amount: 500, variancePct: 0.02 },
      director: { amount: 5_000, variancePct: 0.05 },
    },
  },
  {
    id: "meridian-distribution",
    name: "Meridian Distribution (relaxed)",
    tolerances: { pricePct: 0.05, lineAmountAbs: 0.5, qtyAbs: 0 },
    approvalPolicy: {
      manager: { amount: 5_000, variancePct: 0.1 },
      director: { amount: 50_000, variancePct: 0.2 },
    },
  },
];

const DEFAULT_PROFILE_ID = "standard";

/** Look up a profile by id; falls back to the standard profile. */
export const profileById = (id: string | null | undefined): ClientProfile => {
  return (
    CLIENT_PROFILES.find((p) => p.id === id) ??
    nonNull(
      CLIENT_PROFILES.find((p) => p.id === DEFAULT_PROFILE_ID),
      `the "${DEFAULT_PROFILE_ID}" profile is always seeded`,
    )
  );
};
