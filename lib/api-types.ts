import { z } from "zod";

/**
 * The typed wire contract for the streaming run endpoint, imported by BOTH the
 * route and the client so a shape change is a compile error on both sides (the
 * same discipline as the sibling ai-invoice-parser repo).
 */

/** POST body: which seeded invoice ROW (by its stable id) to run the pipeline on. */
export const RunRequest = z.object({
  id: z.string().min(1, "an invoice id is required"),
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
export interface StreamDone {
  done: true;
  /** Total wall-clock duration of the run, ms. */
  durationMs: number;
}
