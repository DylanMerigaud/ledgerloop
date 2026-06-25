"use client";

import { TraceDetail } from "@/components/trace-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { statusDot, statusTone, stageLabel } from "@/lib/display";
import { formatDuration, humanize } from "@/lib/format";
import type { TraceEvent } from "@/lib/trace";
import type { PipelineRunState } from "@/lib/use-pipeline-run";

/**
 * The execution trace — a vertical timeline streamed in live as the run
 * progresses. Each node is one TraceEvent: the deterministic steps, the
 * investigator agent's tool calls and recommendation, and (rendered red/amber)
 * the caught discrepancies and the routing to approval. This is the heart of the
 * demo — you watch the agent choose its tools and the human gate pause the run.
 */
export const TraceTimeline = ({
  state,
  invoiceLabel,
  canRun,
  onRun,
}: {
  state: PipelineRunState;
  invoiceLabel: string | null;
  canRun: boolean;
  onRun: () => void;
}) => {
  if (state.status === "idle") {
    return (
      <Empty
        title="Run the pipeline"
        body={
          invoiceLabel
            ? `Run ${invoiceLabel} through matching, routing, and reconciliation — live. Pick a flagged invoice (price or quantity mismatch) to watch the investigator agent dig into the variance, then pause for your decision.`
            : "Select an invoice to begin. Flagged ones — a price or quantity mismatch — trigger the investigator agent and pause for your decision."
        }
        action={
          canRun ? (
            <Button
              data-testid="run-btn"
              onClick={onRun}
              className="mt-5 animate-breath"
            >
              Run pipeline
            </Button>
          ) : null
        }
      />
    );
  }

  if (state.status === "error") {
    return (
      <Empty
        title="Run failed"
        body={state.error ?? "Something went wrong starting the run."}
        tone="danger"
      />
    );
  }

  // Intake is rendered by the ExtractionReveal panel above the timeline, so drop
  // its node here (it would duplicate what the reveal already shows).
  const nodes = state.trace.filter((e) => e.stage !== "intake");

  return (
    <div className="space-y-0">
      {nodes.map((e, i) => (
        <TraceNode
          // Key by stepId when present (stable + unique per stage, survives the
          // phase-2 resume where the seq counter restarts and could collide);
          // fall back to seq for run-level markers that carry no stepId.
          key={e.stepId || `seq-${e.seq}`}
          event={e}
          isLast={i === nodes.length - 1}
          live={state.status === "running"}
        />
      ))}

      {state.status === "running" && <PendingNode />}

      {state.status === "awaiting" && (
        <div className="ml-8 mt-1 rounded-lg bg-warn-soft/60 px-3 py-2 text-[12px] text-warn ring-1 ring-inset ring-warn-line">
          Paused — this invoice needs a human decision. Approve or reject it
          above to continue.
        </div>
      )}

      {state.status === "done" && state.durationMs != null && (
        <div className="pl-8 pt-2">
          <span className="text-[11px] text-muted tnum">
            Completed in {formatDuration(state.durationMs)} ·{" "}
            {state.trace.length} events
          </span>
        </div>
      )}
    </div>
  );
};

const TraceNode = ({
  event,
  isLast,
  live,
}: {
  event: TraceEvent;
  isLast: boolean;
  live: boolean;
}) => {
  const dot = statusDot(event.status);
  const isRunning = event.status === "running" && live;
  const showStageChip = event.stage !== "pipeline" && event.kind !== "tool";

  return (
    <div
      className="relative animate-trace-in pl-8"
      data-testid={`trace-${event.kind}-${event.stage}`}
      data-status={event.status}
    >
      {/* connector line */}
      {!isLast && (
        <span
          aria-hidden
          className="absolute left-[7px] top-3 h-full w-px bg-line-strong"
        />
      )}
      {/* dot */}
      <span
        aria-hidden
        className={`absolute left-0 top-[5px] h-3.5 w-3.5 rounded-full ring-2 ring-surface ${
          isRunning ? "animate-pulse-ring" : ""
        }`}
        style={{ backgroundColor: dot }}
      />

      <div className="pb-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`text-[13px] font-medium ${
              event.kind === "tool" ? "font-mono text-muted" : "text-ink"
            }`}
          >
            {event.label}
          </span>
          {showStageChip && event.kind !== "run" && (
            <Badge tone={statusTone(event.status)}>{verdictChip(event)}</Badge>
          )}
          <span className="ml-auto text-[10px] tabular-nums text-muted/70">
            {formatDuration(event.atMs)}
          </span>
        </div>

        {event.detail && (
          <p className="mt-0.5 text-[12px] leading-snug text-ink/70">
            {event.detail}
          </p>
        )}

        {event.data != null && (
          <div className="mt-1.5">
            <TraceDetail data={event.data} />
          </div>
        )}
      </div>
    </div>
  );
};

/** Short chip text summarizing a step's outcome (verdict / tier / posted). */
const verdictChip = (event: TraceEvent): string => {
  const d = event.data as Record<string, unknown> | undefined;
  if (d) {
    if (typeof d["verdict"] === "string") return humanize(d["verdict"]);
    if (typeof d["tier"] === "string") return humanize(d["tier"]);
    if (typeof d["outcome"] === "string") return humanize(d["outcome"]); // posted/awaiting/rejected/blocked
    if ("posted" in d) return d["posted"] ? "Posted" : "Not posted";
  }
  if (event.status === "running") return "Running";
  return stageLabel(event.stage);
};

const PendingNode = () => {
  return (
    <div className="relative pl-8">
      <span
        aria-hidden
        className="absolute left-0 top-[5px] h-3.5 w-3.5 animate-pulse-ring rounded-full bg-accent ring-2 ring-surface"
      />
      <div className="pb-4">
        <span className="text-[13px] text-muted">Working…</span>
      </div>
    </div>
  );
};

const Empty = ({
  title,
  body,
  tone = "neutral",
  action = null,
}: {
  title: string;
  body: string;
  tone?: "neutral" | "danger";
  action?: React.ReactNode;
}) => {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center px-8 text-center">
      <p
        className={`text-[15px] font-semibold ${tone === "danger" ? "text-danger" : "text-ink"}`}
      >
        {title}
      </p>
      <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-muted">
        {body}
      </p>
      {action}
    </div>
  );
};
