import { z } from "zod";

/**
 * The trace model — the wire contract between the streaming route and the
 * timeline UI, and the on-screen embodiment of "this is real multi-agent
 * orchestration, not a prompt wrapper."
 *
 * Mastra emits a rich, low-level `WorkflowStreamEvent` stream (workflow-start,
 * workflow-step-start, tool-call, workflow-step-result, workflow-finish, …). We
 * don't ship those raw shapes to the browser: we ADAPT them into a small, stable
 * `TraceEvent` union the UI can render directly. Two reasons, both worth saying
 * on a sales call:
 *
 *   1. Decoupling — the dashboard depends on OUR vocabulary (stages, statuses),
 *      not Mastra's internal chunk format, so a Mastra version bump can't break
 *      the UI contract.
 *   2. Graceful failure — `toTraceEvent` never throws. An unrecognized or
 *      malformed chunk maps to `null` (dropped) rather than crashing the stream;
 *      the route additionally surfaces real errors as a `pipeline-error` event,
 *      so a bad model output becomes a red trace step, not a white screen.
 *
 * These types are derived from Zod so the same single-source-of-truth discipline
 * the rest of the repo uses also governs what crosses the network.
 */

/** The four pipeline stages, plus a synthetic "pipeline" lane for run-level events. */
export const TraceStage = z.enum([
  "pipeline",
  "intake",
  "matching",
  "approval",
  "reconciliation",
]);
export type TraceStage = z.infer<typeof TraceStage>;

/** Map a Mastra step id to its pipeline stage (step ids are defined in the workflow). */
export function stageForStep(stepId: string): TraceStage {
  if (stepId.startsWith("intake")) return "intake";
  if (stepId.startsWith("matching")) return "matching";
  // "approval" and "approval-auto" both belong to the Approval stage.
  if (stepId.startsWith("approval")) return "approval";
  if (stepId.startsWith("reconciliation") || stepId.startsWith("recon")) {
    return "reconciliation";
  }
  return "pipeline";
}

/**
 * Internal orchestration steps we DON'T surface on the timeline. The `.map()`
 * normalisation step Mastra inserts between the branch and reconciliation gets an
 * auto-generated id like `mapping_<uuid>`; it's plumbing, not an agent stage, so
 * we drop its events rather than render a confusing extra node. (An empty step id
 * is NOT treated as internal here — tool-call chunks carry a tool name instead of
 * a step id and are mapped to their stage by `stageForTool`.)
 */
function isMappingStep(stepId: string): boolean {
  return stepId.startsWith("mapping");
}

/** Map one of our tool names to its pipeline stage (tool-call chunks carry the name, not a step id). */
function stageForTool(toolName: string): TraceStage {
  if (toolName === "run-match") return "matching";
  if (toolName === "route-approval") return "approval";
  if (toolName === "post-to-erp") return "reconciliation";
  return "pipeline";
}

export const TraceStatus = z.enum(["running", "ok", "warn", "error", "skipped"]);
export type TraceStatus = z.infer<typeof TraceStatus>;

/**
 * One entry on the timeline. `kind` separates the structural lifecycle of a stage
 * (`step`) from notable things that happened inside it — a tool firing
 * (`tool`), a caught discrepancy (`finding`, rendered red/amber), or a run-level
 * marker (`run`). The optional `data` carries the already-validated stage output
 * (MatchResult, ApprovalDecision, …) for the UI to render rich detail.
 */
export const TraceEvent = z
  .object({
    /** Monotonic per-run sequence number, assigned by the route as it relays. */
    seq: z.number().int().nonnegative(),
    kind: z.enum(["run", "step", "tool", "finding"]),
    stage: TraceStage,
    status: TraceStatus,
    /**
     * The Mastra step id this event belongs to (empty for run-level events). The
     * UI groups by this so a step's `start` (running) and `result` (done) events
     * collapse into ONE timeline node that transitions, instead of two stacked
     * nodes.
     */
    stepId: z.string(),
    /** Short title shown on the timeline node, e.g. "Matching agent". */
    label: z.string(),
    /** One-line human detail under the title. */
    detail: z.string().optional(),
    /** Arbitrary already-validated payload for rich rendering (stage outputs). */
    data: z.unknown().optional(),
    /** Wall-clock ms since the run started, for the duration chips. */
    atMs: z.number().nonnegative(),
  })
  .strict();
export type TraceEvent = z.infer<typeof TraceEvent>;

/* ────────────────────────────────────────────────────────────────────────── *
 *  Adapter: raw Mastra chunk → TraceEvent (or null to drop)
 * ────────────────────────────────────────────────────────────────────────── */

/** The subset of a Mastra `WorkflowStreamEvent` we read. Defensive, not exhaustive. */
interface RawChunk {
  type?: unknown;
  payload?: { id?: unknown; status?: unknown; output?: unknown } | unknown;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** Friendly stage label for a step id, e.g. "matching" → "Matching agent". */
function stageLabel(stage: TraceStage): string {
  switch (stage) {
    case "intake":
      return "Intake agent";
    case "matching":
      return "Matching agent";
    case "approval":
      return "Approval agent";
    case "reconciliation":
      return "Reconciliation agent";
    case "pipeline":
      return "Pipeline";
  }
}

/**
 * Convert one raw Mastra chunk to a partial TraceEvent (sans `seq`/`atMs`, which
 * the route stamps). Returns `null` for chunks we intentionally don't surface
 * (internal lifecycle noise) or anything malformed — never throws.
 */
export function toTraceEvent(
  chunk: unknown,
): Omit<TraceEvent, "seq" | "atMs"> | null {
  try {
    const c = chunk as RawChunk;
    const type = typeof c?.type === "string" ? c.type : "";
    const payload = asRecord(c?.payload);
    const stepId = typeof payload?.["id"] === "string" ? (payload["id"] as string) : "";
    const stage = stageForStep(stepId);

    switch (type) {
      case "workflow-start":
        return {
          kind: "run",
          stage: "pipeline",
          status: "running",
          stepId: "",
          label: "Pipeline started",
          detail: "Intake → Matching → Approval → Reconciliation",
        };

      case "workflow-step-start":
        if (isMappingStep(stepId)) return null; // hide the .map() plumbing step
        return {
          kind: "step",
          stage,
          status: "running",
          stepId,
          label: stageLabel(stage),
        };

      case "tool-call": {
        // Tool-call chunks carry a tool name, not a workflow step id, so map the
        // stage from the tool name and key the node by the tool name (it renders
        // as a transient "→ run-match" line under its agent).
        const name =
          typeof payload?.["toolName"] === "string"
            ? (payload["toolName"] as string)
            : "tool";
        return {
          kind: "tool",
          stage: stageForTool(name),
          status: "running",
          stepId: `tool:${name}`,
          label: `→ ${name}`,
        };
      }

      case "workflow-step-result":
      case "workflow-step-finish": {
        if (isMappingStep(stepId)) return null; // hide the .map() plumbing step
        const rawOut = asRecord(payload?.["output"]);
        // Steps emit a domain object plus a `narration` string, and some wrap the
        // domain object (the approval step outputs `{ decision, match, vendor }`).
        // `domain` is the object the UI should colour + render; `narration` is the
        // agent's prose. Unwrapping here keeps the UI decoupled from step shapes.
        const narration =
          typeof rawOut?.["narration"] === "string" ? (rawOut["narration"] as string) : undefined;
        const domain = unwrapStageData(rawOut);
        return {
          kind: "step",
          stage,
          status: stepStatusFromOutput(domain),
          stepId,
          label: stageLabel(stage),
          detail: narration ?? stepDetailFromOutput(domain),
          data: domain,
        };
      }

      case "workflow-finish":
        return {
          kind: "run",
          stage: "pipeline",
          status: "ok",
          stepId: "",
          label: "Pipeline complete",
        };

      case "workflow-canceled":
        return {
          kind: "run",
          stage: "pipeline",
          status: "error",
          stepId: "",
          label: "Pipeline canceled",
        };

      default:
        return null; // step-output/-progress/-waiting/reasoning/etc — not surfaced
    }
  } catch {
    return null; // never let a weird chunk crash the stream
  }
}

/**
 * Pull the domain object the UI should render out of a step's raw output. Most
 * steps emit the domain object's fields at the top level (alongside `narration`);
 * the approval step wraps it as `{ decision, match, vendor }`. We return the
 * approval DECISION in that case (that's what the approval node shows), falling
 * back to the raw output for the flat steps.
 */
function unwrapStageData(
  out: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!out) return undefined;
  const decision = asRecord(out["decision"]);
  if (decision && "tier" in decision) return decision;
  return out;
}

/** Derive a traffic-light status from a stage's domain object, if recognizable. */
function stepStatusFromOutput(out: Record<string, unknown> | undefined): TraceStatus {
  if (!out) return "ok";
  // MatchResult
  if (out["verdict"] === "duplicate") return "error";
  if (out["verdict"] === "exception") return "warn";
  if (out["verdict"] === "clean") return "ok";
  // ApprovalDecision
  if (out["tier"] === "blocked") return "error";
  if (out["tier"] === "manager" || out["tier"] === "director") return "warn";
  if (out["tier"] === "auto") return "ok";
  // ReconResult
  if (out["posted"] === false) return "error";
  return "ok";
}

/** Fallback one-line summary when a stage produced no narration. */
function stepDetailFromOutput(out: Record<string, unknown> | undefined): string | undefined {
  if (!out) return undefined;
  if (typeof out["reason"] === "string") return out["reason"] as string;
  if (typeof out["note"] === "string") return out["note"] as string;
  return undefined;
}

/** Build a synthetic error event (used by the route when a step throws). */
export function pipelineErrorEvent(
  message: string,
  stage: TraceStage = "pipeline",
): Omit<TraceEvent, "seq" | "atMs"> {
  return {
    kind: "finding",
    stage,
    status: "error",
    stepId: "",
    label: "Pipeline error",
    detail: message,
  };
}
