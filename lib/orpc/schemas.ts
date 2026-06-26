import { z } from "zod";

import { ApprovalWorkflow } from "@/lib/approval-workflow";
import { TraceEvent } from "@/lib/trace";

/**
 * Shared input/output schemas for the oRPC API contract. Defined ONCE here and used
 * by both the server router and the typed client, so a response-shape change is a
 * compile error on both sides — the whole reason for oRPC over hand-rolled
 * `res.json() as T`.
 */

/* ── onboarding ──────────────────────────────────────────────────────────────── */

export const OrgEmployee = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  department: z.string(),
  division: z.string(),
  managerId: z.string().nullable(),
});
export type OrgEmployee = z.infer<typeof OrgEmployee>;

const RoleResolution = z.object({
  role: z.string(),
  title: z.string(),
  employeeName: z.string().nullable(),
  rationale: z.string(),
});

export const OnboardingResult = z.object({
  source: z.string(),
  employeeCount: z.number(),
  employees: z.array(OrgEmployee),
  workflow: ApprovalWorkflow,
  proposal: z.object({
    directorThreshold: z.number(),
    roles: z.array(RoleResolution),
    summary: z.string(),
  }),
  issues: z.array(
    z.object({
      employeeName: z.string(),
      detail: z.string(),
      note: z.string(),
    }),
  ),
  /** Up to three AI-generated next-edit suggestions for the derived workflow. */
  suggestions: z.array(z.string()),
});
export type OnboardingResult = z.infer<typeof OnboardingResult>;

/* ── workflow edit ───────────────────────────────────────────────────────────── */

const StepChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), id: z.string(), label: z.string() }),
  z.object({ kind: z.literal("removed"), id: z.string(), label: z.string() }),
  z.object({
    kind: z.literal("changed"),
    id: z.string(),
    label: z.string(),
    fields: z.array(z.string()),
  }),
  z.object({ kind: z.literal("unchanged"), id: z.string(), label: z.string() }),
]);

export const EditInput = z.object({
  workflow: ApprovalWorkflow,
  instruction: z.string().trim().min(1, "an instruction is required"),
  /** The departments that exist in the client's org, so a department gate can only
      target a real one (the agent returns a clarify when it can't). Optional —
      defaults to none, in which case any department instruction is clarified. */
  departments: z.array(z.string()).default([]),
  /** The vendors present on the invoices/POs, so a vendor gate targets a real one
      (the agent declines an unknown vendor). */
  vendors: z.array(z.string()).default([]),
  /** The currencies present on the invoices, for the same reason. */
  currencies: z.array(z.string()).default([]),
});

/** The agent asks for a missing piece (e.g. which department) — the UI shows the
    question + clickable options; the user's pick re-submits a completed instruction. */
const ClarificationSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
});

export const EditResult = z.object({
  proposed: ApprovalWorkflow,
  changes: z.array(StepChangeSchema),
  reason: z.string().nullable(),
  /** Set when the agent needs a clarification before editing (workflow unchanged). */
  clarify: ClarificationSchema.nullable(),
});

/* ── run history (the audit trail) ───────────────────────────────────────────── */

/** One row in the "recent runs" list — light metadata, newest first. */
const RunHistoryItem = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  verdict: z.string(),
  outcome: z.string(),
  durationMs: z.number(),
  createdAt: z.string(),
});

export const HistoryResult = z.object({
  runs: z.array(RunHistoryItem),
});
export type HistoryResult = z.infer<typeof HistoryResult>;

export const ReplayInput = z.object({ id: z.string() });

/** A stored run replayed from the audit log — its exact trace, re-rendered with no
    model call. `null` when the row is gone (e.g. cleared by the nightly reset). */
export const ReplayResult = z.object({
  invoiceNumber: z.string(),
  trace: z.array(TraceEvent),
});
