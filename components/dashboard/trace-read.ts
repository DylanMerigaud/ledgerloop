import { z } from "zod";

import type { ExtractionState } from "@/components/extraction-reveal";
import type { StepStatuses } from "@/components/workflow-graph";
import { contextFromMatch } from "@/lib/approval-run";
import {
  ApprovalWorkflow,
  resolvePath,
  type ApprovalWorkflow as TApprovalWorkflow,
  type InvoiceContext,
} from "@/lib/approval-workflow";
import { isRecord } from "@/lib/assert";
import { Invoice, MatchResult } from "@/lib/schema";
import type { TraceEvent } from "@/lib/trace";

/** The LAST trace event matching a predicate. A live run upserts a stage in place (one
    event), but a stored/replayed trace keeps the running (often empty) AND the done
    (data-carrying) event for a stage, in order, so we must read the last, not the first.
    (Local helper rather than Array.findLast, which needs a newer lib target.) */
const findLastEvent = (
  trace: TraceEvent[],
  pred: (e: TraceEvent) => boolean
): TraceEvent | undefined => {
  for (let i = trace.length - 1; i >= 0; i--) {
    const e = trace[i];
    if (e && pred(e)) return e;
  }
  return undefined;
};

/**
 * Pull the intake (extraction) node out of the trace and shape it for the reveal.
 * The intake step carries `{ document }` while reading and `{ extracted, matches }`
 * once done; we render the document twin + scan from that. Returns null until an
 * intake event exists (i.e. before a run starts, or on a resume).
 */
const IntakeData = z
  .object({
    document: Invoice.optional(),
    extracted: Invoice.optional(),
    matches: z.boolean().optional(),
  })
  .passthrough();
export const readIntake = (
  trace: TraceEvent[]
): { document: Invoice; state: ExtractionState } | null => {
  const intake = trace.find((e) => e.stage === "intake" && e.kind === "step");
  if (!intake) return null;
  // Validate the intake payload (a `.safeParse`, like the other trace reads) rather
  // than casting `unknown`, so a drifted event yields null instead of garbage fields.
  const parsed = IntakeData.safeParse(intake.data ?? {});
  if (!parsed.success) return null;
  const data = parsed.data;
  const document = data.extracted ?? data.document;
  if (!document) return null;
  return {
    document,
    state: {
      status: intake.status === "running" ? "running" : "done",
      extracted: data.extracted ?? null,
      matches: data.matches ?? false,
    },
  };
};

/**
 * Pull the approval workflow + each step's live status out of the trace, so the
 * Pipeline can render the SAME graph the onboarding screen draws, lit up by this
 * invoice's path (a gate "In review", "Approved", "Skipped"). The approval node
 * carries `{ workflow, steps: [{id, status}] }`; we validate the workflow off the
 * trace (no cast) and map the step statuses into the shape WorkflowGraph wants.
 * Returns null until the run has produced an approval node (intake/matching first).
 */
export const readRunGraph = (
  trace: TraceEvent[]
): { workflow: TApprovalWorkflow; statuses: StepStatuses } | null => {
  // findLast, not find: a live run upserts the approval node in place (one event), but
  // a STORED/replayed trace keeps both the "running" event (empty data) AND the "done"
  // event (which carries the workflow + steps) under the same stepId. `find` grabbed the
  // running one → no workflow → the graph fell back to the full unresolved default. Take
  // the LAST approval event so replay resolves the same lit path a live run shows.
  const approval = findLastEvent(trace, (e) => e.stage === "approval" && e.kind === "step");
  if (!approval || !isRecord(approval.data)) return null;
  const parsed = ApprovalWorkflow.safeParse(approval.data["workflow"]);
  if (!parsed.success) return null;

  const statuses: StepStatuses = {};
  const steps = approval.data["steps"];
  if (Array.isArray(steps)) {
    for (const s of steps) {
      if (isRecord(s) && typeof s["id"] === "string" && typeof s["status"] === "string") {
        statuses[s["id"]] = s["status"];
      }
    }
  }
  // A BLOCKED run (duplicate) never entered the workflow: a control failed at intake
  // before any gate could route, so the block step emits an empty `steps`. Drawing the
  // full workflow with no statuses reads as if the bill routed normally, which is
  // wrong. Grey EVERY node (status "skipped") so the canvas shows the workflow was not
  // taken, and let the red outcome banner carry the why. Detected from the outcome
  // (approval `blocked`) or the matching verdict (`duplicate`).
  if (isBlockedRun(trace, approval.data)) {
    const skipped: StepStatuses = {};
    for (const s of parsed.data.steps) skipped[s.id] = "skipped";
    return { workflow: parsed.data, statuses: skipped };
  }
  // Resolve the LINEAR path THIS invoice takes: evaluate each gate's condition against
  // the matched invoice and drop the ones that don't apply (rewiring edges), so the
  // reviewer sees the realized chain (e.g. Manager → Post when Director's threshold
  // isn't met), not every conditional gate. Keyed on the invoice (from the matching
  // event), NOT on approval order, so it's fixed the moment matching resolves and never
  // re-routes as gates get decided. If matching data isn't on the trace yet, draw the
  // full workflow.
  const ctx = readMatchContext(trace);
  return { workflow: resolvePath(parsed.data, ctx), statuses };
};

/** True when the run was blocked at a pre-workflow control (a duplicate), so nothing
    routed. Reads the approval event's `outcome` (blocked) or the matching verdict. */
const isBlockedRun = (trace: TraceEvent[], approvalData: Record<string, unknown>): boolean => {
  if (approvalData["outcome"] === "blocked") return true;
  // findLast: the stored trace keeps the running (empty) + done matching events; the
  // verdict is on the done one.
  const matching = findLastEvent(trace, (e) => e.stage === "matching" && e.kind === "step");
  return isRecord(matching?.data) && matching.data["verdict"] === "duplicate";
};

/** The exception investigator's recommendation, pulled from the trace, so the paused
    gate can show what the AI concluded right where the human decides (verdict + the
    reasoning on hover), instead of only in the trace drawer. Null until the agent has
    produced a recommendation. */
export type Recommendation = {
  verdict: "likely_legitimate" | "likely_overcharge" | "unclear";
  rationale: string | null;
};
export const readRecommendation = (trace: TraceEvent[]): Recommendation | null => {
  const inv = findLastEvent(trace, (e) => e.stage === "investigation" && e.data != null);
  if (!inv || !isRecord(inv.data)) return null;
  const rec = inv.data["recommendation"];
  const verdict =
    rec === "likely_legitimate"
      ? "likely_legitimate"
      : rec === "likely_overcharge"
        ? "likely_overcharge"
        : "unclear";
  const rationale = typeof inv.data["rationale"] === "string" ? inv.data["rationale"] : null;
  return { verdict, rationale };
};

/** Build the approval engine's InvoiceContext from the matching trace event, so the
    run graph's path can be resolved client-side. Returns undefined (draw the full
    graph) if the matching event isn't present/valid yet.

    The matching step emits the MatchResult PLUS run-plumbing (`decisions`, `profile`,
    `narration`, …), so we validate only the MatchResult fields and `.passthrough()`
    the extras, rather than strict-parsing the whole event (which would reject it). */
const MatchResultLoose = MatchResult.passthrough();
const readMatchContext = (trace: TraceEvent[]): InvoiceContext | undefined => {
  // findLast: the done matching event (with the MatchResult) follows the running one.
  const matching = findLastEvent(trace, (e) => e.stage === "matching" && e.kind === "step");
  if (!matching || !isRecord(matching.data)) return undefined;
  const parsed = MatchResultLoose.safeParse(matching.data);
  return parsed.success ? contextFromMatch(parsed.data) : undefined;
};
