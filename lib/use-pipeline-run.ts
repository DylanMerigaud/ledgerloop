"use client";

import { useCallback, useRef, useState } from "react";
import { TraceEvent } from "@/lib/trace";
import { NdjsonBuffer } from "@/lib/ndjson";
import { type StreamDone } from "@/lib/api-types";
import type { Outcome } from "@/lib/display";
import {
  deriveOutcome,
  isAwaitingApproval,
  decisionsForPending,
} from "@/lib/run-outcome";

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

export interface PipelineRunState {
  status: "idle" | "running" | "awaiting" | "done" | "error";
  trace: TraceEvent[];
  outcome: Outcome;
  durationMs: number | null;
  error: string | null;
}

const IDLE: PipelineRunState = {
  status: "idle",
  trace: [],
  outcome: "pending",
  durationMs: null,
  error: null,
};

export function usePipelineRun() {
  const [state, setState] = useState<PipelineRunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  // The trace + step index persist ACROSS phases so a phase-2 approve/reject
  // continues the existing timeline (re-streamed intake/matching/approval nodes
  // upsert in place by stepId; reconciliation transitions awaiting → posted).
  const eventsRef = useRef<TraceEvent[]>([]);
  const stepIndexRef = useRef<Map<string, number>>(new Map());

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    eventsRef.current = [];
    stepIndexRef.current = new Map();
    setState(IDLE);
  }, []);

  /**
   * Stream one run/resume. `decision` undefined = phase 1 (may pause for a
   * human); "approve"/"reject" = phase 2 resume onto the existing trace.
   */
  const stream = useCallback(
    async (id: string, decision?: "approve" | "reject") => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Phase 1 starts a fresh trace; phase 2 keeps the existing one.
      if (!decision) {
        eventsRef.current = [];
        stepIndexRef.current = new Map();
      }
      setState((s) => ({
        ...s,
        status: "running",
        outcome: "running",
        error: null,
      }));

      const resuming = decision !== undefined;
      const push = (e: TraceEvent) => {
        const events = eventsRef.current;
        const stepIndex = stepIndexRef.current;

        // On a phase-2 RESUME the workflow re-runs end-to-end, so it re-emits the
        // whole front of the pipeline. We've already shown those nodes — surface
        // ONLY the reconciliation stage (the part that actually advances) and drop
        // the replayed run markers / earlier stages, so there's no second
        // "Pipeline started" or duplicated upstream steps.
        if (resuming && e.stage !== "reconciliation") return;

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
        // The approval workflow can have several gates pending in parallel. The
        // single Approve/Reject button applies the reviewer's decision to ALL of
        // them (the collect-all set), sent as the per-step `decisions` map. (A
        // richer per-gate UI can send a subset.)
        const body = decision
          ? { id, decisions: decisionsForPending(eventsRef.current, decision) }
          : { id };
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const msg = await res
            .json()
            .then((j: { error?: string }) => j.error)
            .catch(() => null);
          setState((s) => ({
            ...s,
            status: "error",
            outcome: "pending",
            error: msg ?? `Run failed (HTTP ${res.status}).`,
          }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const lines = new NdjsonBuffer();
        let durationMs: number | null = null;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const raw of lines.push(
            decoder.decode(value, { stream: true }),
          )) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              continue;
            }
            if (parsed && typeof parsed === "object" && "done" in parsed) {
              durationMs = (parsed as StreamDone).durationMs;
              continue;
            }
            const result = TraceEvent.safeParse(parsed);
            if (result.success) push(result.data);
          }
        }

        // If the run paused for a human decision, surface that as `awaiting` (not
        // `done`) so the UI shows Approve / Reject instead of "Run again".
        const awaiting = !decision && isAwaitingApproval(eventsRef.current);

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
    [],
  );

  const run = useCallback((id: string) => stream(id), [stream]);
  const decide = useCallback(
    (id: string, decision: "approve" | "reject") => stream(id, decision),
    [stream],
  );

  return { state, run, decide, reset };
}
