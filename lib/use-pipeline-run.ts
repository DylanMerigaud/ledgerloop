"use client";

import { useRef, useState } from "react";

import { useEventCallback } from "@/hooks/use-event-callback";
import { isStreamDone } from "@/lib/api-types";
import type { ApprovalWorkflow } from "@/lib/approval-workflow";
import type { Outcome } from "@/lib/display";
import { client } from "@/lib/orpc/client";
import {
  deriveOutcome,
  isAwaitingApproval,
  decisionsForPending,
} from "@/lib/run-outcome";
import type { TraceEvent } from "@/lib/trace";

/**
 * Client hook that runs the pipeline for an invoice and exposes the live trace.
 *
 * It POSTs to /api/run and reads the NDJSON response with
 * fetch + response.body.getReader() — the streaming-read counterpart to the
 * route's ReadableStream. Each newline-delimited line is parsed and validated
 * with the SAME `TraceEvent` Zod schema the server stamps, so a malformed line
 * can't corrupt the UI state. Events accrue into `trace`; the run's coarse
 * `outcome` is derived as they arrive so the queue pill can update in real time.
 */

export type PipelineRunState = {
  status: "idle" | "running" | "awaiting" | "done" | "error";
  trace: TraceEvent[];
  outcome: Outcome;
  durationMs: number | null;
  error: string | null;
};

const IDLE: PipelineRunState = {
  status: "idle",
  trace: [],
  outcome: "pending",
  durationMs: null,
  error: null,
};

export const usePipelineRun = (workflow: ApprovalWorkflow | null) => {
  const [state, setState] = useState<PipelineRunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  // The active workflow the run executes against, kept in a ref so the stable
  // `stream` callback always reads the latest without re-creating. null → the
  // server falls back to its default DAG. The phase-2 resume sends the SAME
  // workflow as phase 1 so the re-walked gates match (the run is stateless: the
  // workflow is re-sent, not stored).
  const workflowRef = useRef<ApprovalWorkflow | null>(workflow);
  workflowRef.current = workflow;
  // The trace + step index persist ACROSS phases so a phase-2 approve/reject
  // continues the existing timeline (re-streamed intake/matching/approval nodes
  // upsert in place by stepId; reconciliation transitions awaiting → posted).
  const eventsRef = useRef<TraceEvent[]>([]);
  const stepIndexRef = useRef<Map<string, number>>(new Map());
  // Decisions ACCUMULATE across approval waves. The run is stateless — it recomputes
  // the whole DAG from the decisions each call — so a workflow with gates behind
  // other gates (a later wave reached only once an earlier one is approved) needs the
  // UNION of every decision so far, not just the wave just acted on. Without this, an
  // earlier wave's approval would be lost on the next resume and the bill never posts.
  const decisionsRef = useRef<Record<string, "approve" | "reject">>({});
  // Reviewer notes per REJECTED gate, accumulated alongside decisions (same UNION
  // discipline) so a note set in an earlier wave isn't lost on a later resume.
  const reasonsRef = useRef<Record<string, string>>({});

  const reset = useEventCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    eventsRef.current = [];
    stepIndexRef.current = new Map();
    decisionsRef.current = {};
    reasonsRef.current = {};
    setState(IDLE);
  });

  /**
   * Stream one run/resume. `decisions` undefined = phase 1 (may pause for a
   * human); a per-gate map = phase 2 resume onto the existing trace. The caller
   * builds the map: the single Approve/Reject button batches every pending gate
   * (`decide`), the per-node controls send an explicit per-gate map (`decideMany`).
   */
  const stream = useEventCallback(
    async (
      id: string,
      decisions?: Record<string, "approve" | "reject">,
      reasons?: Record<string, string>,
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Phase 1 starts a fresh trace; phase 2 keeps the existing one.
      if (!decisions) {
        eventsRef.current = [];
        stepIndexRef.current = new Map();
        decisionsRef.current = {};
        reasonsRef.current = {};
      }
      setState((s) => ({
        ...s,
        status: "running",
        outcome: "running",
        error: null,
      }));

      const resuming = decisions !== undefined;
      const push = (e: TraceEvent) => {
        const events = eventsRef.current;
        const stepIndex = stepIndexRef.current;

        // On a phase-2 RESUME the workflow re-runs end-to-end, so it re-emits the
        // whole front of the pipeline. We've already shown the upstream nodes
        // (intake/matching/investigation) and they don't advance — drop them and the
        // replayed run markers so there's no second "Pipeline started" or duplicated
        // upstream steps. But KEEP approval + reconciliation: those DO advance (the
        // approval node updates its per-step states — a just-approved gate, and a
        // NEXT gate that a wave reached now pends), upserting in place by stepId. This
        // is what lets a multi-wave workflow re-pause instead of silently posting.
        if (
          resuming &&
          e.stage !== "approval" &&
          e.stage !== "reconciliation"
        ) {
          return;
        }
        if (resuming && e.kind === "run") return; // never replay run markers

        // UPSERT anything with a stepId (steps AND tool nodes carry stable ids) so a
        // stage is a single node that transitions running → done, and across phases
        // awaiting → posted — instead of stacking duplicates. Run markers append.
        if (e.stepId) {
          const existing = stepIndex.get(e.stepId);
          if (existing !== undefined) {
            events[existing] = e;
          } else {
            stepIndex.set(e.stepId, events.length);
            events.push(e);
          }
        } else {
          events.push(e);
        }
        setState((s) => ({
          ...s,
          trace: [...events],
          outcome: deriveOutcome(events, false),
        }));
      };

      try {
        // The approval workflow can have several gates pending in parallel. The caller
        // hands us the decisions for THIS wave (the single button batches every pending
        // gate; the per-node controls send one entry per gate). We MERGE that into the
        // running accumulator and send the union, so an earlier wave's approvals aren't
        // lost when a later wave is acted on (the run is stateless — it rebuilds the
        // whole DAG from the decisions). Deciding only SOME pending gates leaves the
        // rest unset → the engine keeps them pending and the run re-pauses on them. The
        // active workflow rides along on both phases so the run routes through exactly
        // the one on screen; omitted when null so the server uses its default DAG.
        const activeWorkflow = workflowRef.current ?? undefined;
        if (decisions) {
          decisionsRef.current = { ...decisionsRef.current, ...decisions };
          if (reasons)
            reasonsRef.current = { ...reasonsRef.current, ...reasons };
        }
        const body = decisions
          ? {
              id,
              decisions: decisionsRef.current,
              reasons: reasonsRef.current,
              workflow: activeWorkflow,
            }
          : { id, workflow: activeWorkflow };
        // The oRPC `run` procedure is an event iterator: a typed async stream of
        // TraceEvent | StreamDone. No manual reader / NDJSON parse / cast — just
        // iterate, fully typed end-to-end.
        const iterator = await client.run(body, { signal: controller.signal });
        let durationMs: number | null = null;
        for await (const event of iterator) {
          if (isStreamDone(event)) durationMs = event.durationMs;
          else push(event);
        }

        // If the run paused for a human decision, surface that as `awaiting` (not
        // `done`) so the UI shows Approve / Reject instead of "Run again". Detected
        // after EVERY phase, resume included: approving one wave can reach a NEXT gate
        // that pends, so a resume must be able to re-pause rather than assume it
        // always completes.
        const awaiting = isAwaitingApproval(eventsRef.current);

        // The workflow runs to completion even when reconciliation is HELD, so it
        // emits a "Pipeline complete" run marker — misleading while paused. Drop the
        // run markers so the trace ends on the awaiting step, matching the "Paused —
        // needs a decision" banner. Rebuild the stepId→index map afterwards so the
        // upserts on the eventual resume still target the right nodes.
        if (awaiting) {
          eventsRef.current = eventsRef.current.filter((e) => e.kind !== "run");
          stepIndexRef.current = new Map();
          eventsRef.current.forEach((e, i) => {
            if (e.stepId) stepIndexRef.current.set(e.stepId, i);
          });
        }

        setState((s) => ({
          ...s,
          trace: [...eventsRef.current],
          status: awaiting ? "awaiting" : "done",
          durationMs,
          outcome: awaiting
            ? "needs-approval"
            : deriveOutcome(eventsRef.current, true),
        }));
      } catch (err) {
        if (controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          status: "error",
          outcome: "pending",
          error:
            err instanceof Error ? err.message : "Network error during run.",
        }));
      }
    },
  );

  const run = useEventCallback((id: string) => stream(id));
  // One decision applied to every gate pending in this wave (the header button). An
  // optional reason (a reject note) is attached to those same gates.
  const decide = useEventCallback(
    (id: string, decision: "approve" | "reject", reason?: string) => {
      const decisions = decisionsForPending(eventsRef.current, decision);
      const note = reason?.trim();
      const reasons = note
        ? Object.fromEntries(Object.keys(decisions).map((k) => [k, note]))
        : undefined;
      return stream(id, decisions, reasons);
    },
  );
  // An explicit per-gate map (the inline node controls) — approve one, reject
  // another in the same parallel wave, each with its own optional reject note.
  const decideMany = useEventCallback(
    (
      id: string,
      perGate: Record<string, "approve" | "reject">,
      reasons?: Record<string, string>,
    ) => stream(id, perGate, reasons),
  );

  /**
   * Render a STORED trace from the audit log (the history view), with no pipeline
   * execution — just drop the persisted events into state so the existing trace +
   * graph components re-render them exactly as they streamed. Aborts any live run
   * first, and seeds the refs so the outcome derives the same as a fresh run.
   */
  const replay = useEventCallback((trace: TraceEvent[]) => {
    abortRef.current?.abort();
    abortRef.current = null;
    eventsRef.current = [...trace];
    stepIndexRef.current = new Map();
    trace.forEach((e, i) => {
      if (e.stepId) stepIndexRef.current.set(e.stepId, i);
    });
    decisionsRef.current = {};
    setState({
      status: "done",
      trace: [...trace],
      outcome: deriveOutcome(trace, true),
      durationMs: null,
      error: null,
    });
  });

  return { state, run, decide, decideMany, reset, replay };
};
