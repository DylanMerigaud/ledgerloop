import { z } from "zod";

import { ApprovalWorkflow } from "@/lib/approval-workflow";
import { TraceEvent } from "@/lib/trace";

/**
 * The typed wire contract for the streaming run endpoint, imported by BOTH the
 * route and the client so a shape change is a compile error on both sides (the
 * same discipline as the sibling ai-invoice-parser repo).
 */

/**
 * POST body: which seeded invoice ROW (by its stable id) to run, plus the
 * reviewer's per-step `decisions`.
 *
 * The approval workflow is a DAG of conditional gates (lib/approval-workflow.ts),
 * so a run can have SEVERAL approval steps pending at once (parallel fan-out). The
 * reviewer decides each by step id:
 *   - {} / omitted              → phase 1: run; active gates PAUSE as pending.
 *   - { "director-review": "approve", … } → phase 2: resolve those gates; the
 *     bill posts only once every active gate is approved.
 * Recomputing the deterministic prefix from the decisions (rather than persisting
 * a snapshot) is what keeps the human-in-the-loop stateless — see the run route.
 * Clean invoices have no active gate and ignore `decisions`.
 */
/** @public — a reviewer's decision on one approval gate. */
export const StepDecision = z.enum(["approve", "reject"]);
export type StepDecision = z.infer<typeof StepDecision>;

export const RunRequest = z.object({
  id: z.string().min(1, "an invoice id is required"),
  /** Reviewer decisions keyed by workflow step id. Omitted on the first run. */
  decisions: z.record(z.string(), StepDecision).optional(),
  /** Optional note the reviewer attached when REJECTING a gate, keyed by step id.
      Sparse (only rejects), so it rides alongside `decisions` rather than folding
      into it. Surfaces in the rejected step's trace detail + the audit history. */
  reasons: z.record(z.string(), z.string()).optional(),
  /** The approval workflow this run executes — the one the onboarding agent
      derived and the user edited, passed in (never persisted: the run stays
      stateless). Optional: when absent the run falls back to the default DAG, so a
      visitor who hasn't run discovery still gets a working pipeline. On a phase-2
      resume the SAME workflow must be sent so the re-walked gates match phase 1. */
  workflow: ApprovalWorkflow.optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

/**
 * The run streams its trace as an oRPC EVENT ITERATOR (a typed async generator) —
 * the procedure yields a sequence of `TraceEvent` and a terminal `StreamDone`, and
 * the client consumes it with `for await`. (This replaced the old NDJSON framing;
 * oRPC now owns the wire, fully typed end to end.)
 */

/** Terminal marker appended after the last trace event. A Zod schema so the client
    validates it off the wire (no cast) the same way it parses each TraceEvent. */
export const StreamDone = z.object({
  done: z.literal(true),
  /** Total wall-clock duration of the run, ms. */
  durationMs: z.number(),
});
export type StreamDone = z.infer<typeof StreamDone>;

/**
 * One line of the NDJSON stream: either a trace event or the terminal done marker.
 * One schema, parsed once; `isStreamDone` discriminates which arrived.
 */
export const StreamLine = z.union([TraceEvent, StreamDone]);
export type StreamLine = z.infer<typeof StreamLine>;

export const isStreamDone = (line: StreamLine): line is StreamDone =>
  "done" in line;
