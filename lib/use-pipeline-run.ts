"use client";

import { useCallback, useRef, useState } from "react";
import { TraceEvent } from "@/lib/trace";
import { NdjsonBuffer } from "@/lib/ndjson";
import { type StreamDone } from "@/lib/api-types";
import type { Outcome } from "@/lib/display";

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
  status: "idle" | "running" | "done" | "error";
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

/** Derive the coarse per-invoice outcome from the trace so far. */
function deriveOutcome(trace: TraceEvent[], finished: boolean): Outcome {
  // Walk the recognized stage outputs for the strongest signal.
  let outcome: Outcome = finished ? "reconciled" : "running";
  for (const e of trace) {
    const data = e.data as Record<string, unknown> | undefined;
    if (!data) continue;
    if (data["verdict"] === "duplicate" || data["tier"] === "blocked" || data["posted"] === false) {
      return "blocked";
    }
    if (data["tier"] === "manager" || data["tier"] === "director") {
      outcome = "needs-approval";
    }
  }
  return outcome;
}

export function usePipelineRun() {
  const [state, setState] = useState<PipelineRunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  const run = useCallback(async (id: string) => {
    // Cancel any in-flight run first.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...IDLE, status: "running", outcome: "running" });

    // Step events arrive twice — once on `start` (running) and once on `result`
    // (done). We UPSERT step nodes by their stepId so each stage is a single
    // timeline node that transitions running → done, instead of two stacked
    // nodes. Run markers, tool calls, and findings are always appended.
    const events: TraceEvent[] = [];
    const stepIndex = new Map<string, number>();
    const push = (e: TraceEvent) => {
      if (e.kind === "step" && e.stepId) {
        const existing = stepIndex.get(e.stepId);
        if (existing !== undefined) {
          events[existing] = e; // replace running node with its result in place
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
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
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
        for (const raw of lines.push(decoder.decode(value, { stream: true }))) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue; // skip an unparseable line rather than failing the run
          }
          if (parsed && typeof parsed === "object" && "done" in parsed) {
            durationMs = (parsed as StreamDone).durationMs;
            continue;
          }
          const result = TraceEvent.safeParse(parsed);
          if (result.success) push(result.data);
        }
      }

      setState((s) => ({
        ...s,
        status: "done",
        durationMs,
        outcome: deriveOutcome(events, true),
      }));
    } catch (err) {
      if (controller.signal.aborted) return; // superseded by a newer run / reset
      setState((s) => ({
        ...s,
        status: "error",
        outcome: "pending",
        error: err instanceof Error ? err.message : "Network error during run.",
      }));
    }
  }, []);

  return { state, run, reset };
}
