import { z } from "zod";

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
  /** Which client profile to run under (tolerances + approval workflow). Optional —
      defaults to the standard profile. This is how the same invoice routes
      differently per onboarded client. */
  profileId: z.string().optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

/**
 * The stream is newline-delimited JSON (NDJSON): each line is one serialized
 * `TraceEvent`, plus a terminal `{ done: true }` sentinel. We use NDJSON over the
 * `text/event-stream` (SSE) framing because the client reads it with
 * fetch + response.body.getReader() (a POST can't use the GET-only EventSource
 * API), and line-delimited JSON is the simplest robust framing for that reader.
 */
export const STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

/** Terminal marker appended after the last trace event. */
export type StreamDone = {
  done: true;
  /** Total wall-clock duration of the run, ms. */
  durationMs: number;
};
