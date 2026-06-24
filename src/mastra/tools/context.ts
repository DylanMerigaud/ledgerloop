/**
 * The keys the workflow injects into an agent's `requestContext` before calling
 * it. An agent's tools READ their inputs from here rather than from
 * model-generated arguments — so a tool genuinely fires (a real `tool-call` in
 * the trace) while the data it reads is the trusted, server-side record, never
 * something the model could hallucinate (e.g. the wrong vendor's file).
 *
 * Only the exception-investigator agent uses context today: the match / route /
 * reconcile stages are pure deterministic functions with no agent in the loop.
 *
 * Keyed by a typed record so `requestContext.get(...)` is type-safe on both ends.
 */
export type ToolContext = {
  /** For the investigator's tools — which vendor's records they may read. */
  investigation: {
    vendor: string;
  };
};

export const CTX = {
  investigation: "investigation",
} as const;
