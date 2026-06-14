"use client";

import { Badge } from "@/components/ui/badge";
import { TraceDetail } from "@/components/trace-detail";
import { formatDuration, humanize } from "@/lib/format";
import { statusDot, statusTone, stageLabel } from "@/lib/display";
import type { TraceEvent } from "@/lib/trace";
import type { PipelineRunState } from "@/lib/use-pipeline-run";

/**
 * The agent execution trace — a vertical timeline streamed in live as the run
 * progresses. Each node is one TraceEvent: the agent steps, the tool calls, and
 * (rendered red/amber) the caught discrepancies and the conditional routing to
 * approval. This is the heart of the demo — the visual proof that it's real
 * multi-agent orchestration, not a single prompt.
 */

export function TraceTimeline({
  state,
  invoiceLabel,
}: {
  state: PipelineRunState;
  invoiceLabel: string | null;
}) {
  if (state.status === "idle") {
    return (
      <Empty
        title="Run the pipeline"
        body={
          invoiceLabel
            ? `Press “Run pipeline” to execute the four agents on ${invoiceLabel} and watch the trace stream here.`
            : "Select an invoice from the queue, then run the pipeline to watch the agents work."
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

  return (
    <div className="space-y-0">
      {state.trace.map((e, i) => (
        <TraceNode key={e.seq} event={e} isLast={i === state.trace.length - 1} live={state.status === "running"} />
      ))}

      {state.status === "running" && <PendingNode />}

      {state.status === "awaiting" && (
        <div className="ml-8 mt-1 rounded-lg bg-warn-soft/60 px-3 py-2 text-[12px] text-warn ring-1 ring-inset ring-warn-line">
          Paused — this invoice needs a human decision. Approve or reject it above to continue.
        </div>
      )}

      {state.status === "done" && state.durationMs != null && (
        <div className="pl-8 pt-2">
          <span className="text-[11px] text-muted tnum">
            Completed in {formatDuration(state.durationMs)} · {state.trace.length} events
          </span>
        </div>
      )}
    </div>
  );
}

function TraceNode({
  event,
  isLast,
  live,
}: {
  event: TraceEvent;
  isLast: boolean;
  live: boolean;
}) {
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
          className="absolute left-[7px] top-3 h-full w-px bg-line"
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
          <p className="mt-0.5 text-[12px] leading-snug text-ink/70">{event.detail}</p>
        )}

        {event.data != null && (
          <div className="mt-1.5">
            <TraceDetail data={event.data} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Short chip text summarizing a step's outcome (verdict / tier / posted). */
function verdictChip(event: TraceEvent): string {
  const d = event.data as Record<string, unknown> | undefined;
  if (d) {
    if (typeof d["verdict"] === "string") return humanize(d["verdict"]);
    if (typeof d["tier"] === "string") return humanize(d["tier"]);
    if (typeof d["outcome"] === "string") return humanize(d["outcome"]); // posted/awaiting/rejected/blocked
    if ("posted" in d) return d["posted"] ? "Posted" : "Not posted";
  }
  if (event.status === "running") return "Running";
  return stageLabel(event.stage);
}

function PendingNode() {
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
}

function Empty({
  title,
  body,
  tone = "neutral",
}: {
  title: string;
  body: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center px-8 text-center">
      <p className={`text-sm font-medium ${tone === "danger" ? "text-danger" : "text-ink"}`}>
        {title}
      </p>
      <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}
