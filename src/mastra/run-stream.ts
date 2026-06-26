import { ORPCError } from "@orpc/server";

import { loadRunBundle } from "@/db/client";
import { profileById } from "@/db/client-profiles";
import { type RunRequest, type StreamDone } from "@/lib/api-types";
import { toTraceEvent, pipelineErrorEvent, type TraceEvent } from "@/lib/trace";
import { mastra } from "@/src/mastra";

/**
 * The procure-to-pay run as a reusable async generator: it yields each TraceEvent
 * as the workflow streams, then a terminal StreamDone. This is the body the oRPC
 * `run` procedure exposes as an event iterator (replacing the old NDJSON
 * ReadableStream in the route).
 *
 * STATELESS BY DESIGN: reads the seeded invoice/PO/receipt, runs the steps, streams
 * the trace, and forgets — never writes to the DB. So every visitor sees the same
 * pristine seeded state. Pipeline failures surface as a red trace event, not a
 * thrown error, so a flaky model degrades the trace instead of blanking the screen.
 */
export const runPipelineStream = async function* (
  input: RunRequest,
): AsyncGenerator<TraceEvent | StreamDone> {
  const decisions = input.decisions ?? {};
  // A resume (decisions present) re-runs from the top but the document was already
  // read — skip the costly vision call the second time.
  const hasDecisions = Object.keys(decisions).length > 0;

  // Load the seeded bundle (READ ONLY). A missing invoice / missing DB config is a
  // clean error BEFORE any streaming, matching the old route's HTTP behaviour.
  let bundle: Awaited<ReturnType<typeof loadRunBundle>>;
  try {
    bundle = await loadRunBundle(input.id);
  } catch (err) {
    const message =
      err instanceof Error && err.message.includes("DATABASE_URL")
        ? "Server is missing DATABASE_URL. Point it at Supabase (see README)."
        : "Could not load the invoice from the database.";
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
  }
  if (!bundle) {
    throw new ORPCError("NOT_FOUND", {
      message: `No seeded invoice with id "${input.id}".`,
    });
  }

  const startedAt = Date.now();
  let seq = 0;
  const stamp = (e: Omit<TraceEvent, "seq" | "atMs">): TraceEvent => ({
    ...e,
    seq: seq++,
    atMs: Date.now() - startedAt,
  });

  try {
    const workflow = mastra.getWorkflow("p2p");
    const wfRun = await workflow.createRun();
    const result = wfRun.stream({
      inputData: {
        invoice: bundle.invoice,
        purchaseOrder: bundle.purchaseOrder,
        goodsReceipt: bundle.goodsReceipt,
        priorInvoiceNumbers: bundle.priorInvoiceNumbers,
        decisions,
        skipExtraction: hasDecisions,
        profile: profileById(input.profileId),
      },
    });

    // Relay Mastra's native event stream, adapting each chunk to a TraceEvent;
    // unrecognized/internal chunks map to null and are dropped.
    const reader = result.fullStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const event = toTraceEvent(value);
      if (event) yield stamp(event);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unexpected pipeline error.";
    yield stamp(pipelineErrorEvent(message));
  }

  yield { done: true, durationMs: Date.now() - startedAt };
};
