"use client";

import { z } from "zod";

import { TraceDetail } from "@/components/trace-detail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { statusDot, statusTone, stageLabel } from "@/lib/display";
import { formatDuration, humanize } from "@/lib/format";
import type { TraceEvent } from "@/lib/trace";
import type { PipelineRunState } from "@/lib/use-pipeline-run";

/**
 * Compose a one-line reason the run paused, from the trace data already on screen:
 * which gate(s) are pending (the approval step's `steps`) and why (the top
 * matching exception's message). Read defensively with `isRecord` — a trace whose
 * shape we don't recognise just yields no extras, so the banner degrades to the
 * plain "needs a human decision" rather than guessing. Keeps the pause LEGIBLE
 * without a paragraph: "Paused at <gate> — <reason>."
 */
/* The slices of the trace data this banner reads, Zod-validated so the unknown
   `data` is narrowed without a cast (same discipline as the rest of the app). */
const ApprovalData = z.object({
  steps: z
    .array(z.object({ status: z.string(), detail: z.string() }))
    .optional(),
});
const MatchingData = z.object({
  exceptions: z.array(z.object({ message: z.string() })).optional(),
});

const pauseReason = (trace: TraceEvent[]): string => {
  const approval = trace.find((e) => e.stage === "approval");
  const matching = trace.find((e) => e.stage === "matching");

  // Pending gate label — the engine's pending detail reads "Awaiting <approver>…".
  let gates = "";
  const ap = ApprovalData.safeParse(approval?.data);
  if (ap.success) {
    const pending = (ap.data.steps ?? []).find((s) => s.status === "pending");
    if (pending) gates = pending.detail.replace(/\.$/, "");
  }

  // The top exception message (e.g. "Line STL-BAR-20: invoiced at 8.18/unit vs PO
  // 7.50/unit (9.1% over).") — the "why".
  let why = "";
  const mt = MatchingData.safeParse(matching?.data);
  if (mt.success) why = mt.data.exceptions?.[0]?.message ?? "";

  if (gates && why) return `Paused — ${gates}. ${why}`;
  if (gates) return `Paused — ${gates}.`;
  if (why) return `Paused — ${why}`;
  return "Paused — this invoice needs a human decision.";
};

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
            ? `Run ${invoiceLabel} through matching, routing, and reconciliation — live.`
            : "Select an invoice to begin."
        }
        action={
          canRun ? (
            <Button data-testid="run-btn" onClick={onRun} className="mt-5">
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
          {pauseReason(state.trace)} Approve or reject above to continue.
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

/** The few summary fields a stage may carry on `data`, for the chip. Validated with
    Zod (data is `unknown` on the trace) so we read TYPED fields, not `d["verdict"]`. */
const ChipFields = z.object({
  verdict: z.string().optional(),
  tier: z.string().optional(),
  outcome: z.string().optional(), // posted / awaiting / rejected / blocked
  posted: z.boolean().optional(),
});

/** Short chip text summarizing a step's outcome (verdict / tier / posted). */
const verdictChip = (event: TraceEvent): string => {
  const d = ChipFields.safeParse(event.data).data;
  if (d) {
    if (d.verdict) return humanize(d.verdict);
    if (d.tier) return humanize(d.tier);
    if (d.outcome) return humanize(d.outcome);
    if (d.posted !== undefined) return d.posted ? "Posted" : "Not posted";
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
