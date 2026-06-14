import { mastra } from "@/src/mastra";
import { loadRunBundle } from "@/db/client";
import { toTraceEvent, pipelineErrorEvent, type TraceEvent } from "@/lib/trace";
import { ndjsonLine } from "@/lib/ndjson";
import { RunRequest, STREAM_CONTENT_TYPE, type StreamDone } from "@/lib/api-types";

/**
 * POST /api/run — execute the procure-to-pay pipeline for one seeded invoice and
 * STREAM the agent execution trace back to the browser as it happens.
 *
 * Runtime: NODE, not Edge. The spec suggested Edge to dodge serverless timeouts
 * on chained agents, but the Postgres driver needs raw TCP sockets that the Edge
 * runtime doesn't provide. Vercel's Node functions support HTTP response
 * streaming AND a configurable maxDuration, which meets the real goal — a long-
 * enough, non-timing-out stream — while keeping the DB driver working. A full
 * four-agent Haiku run is a few seconds, so 60s is ample headroom.
 *
 * STATELESS BY DESIGN: this reads the seeded invoice/PO/receipt, runs the agents,
 * streams the trace, and FORGETS. It never writes to the database — not the
 * agent_runs table, not anything. So the 50th visitor sees the same pristine
 * seeded state as the 1st. (That's why there's no persistence here despite
 * agent_runs existing in the schema — see the README.)
 *
 * Framing: newline-delimited JSON. Each line is one TraceEvent; a final
 * { done, durationMs } sentinel closes the run. Errors are surfaced as red
 * trace events, never thrown past the stream — a flaky model degrades the trace,
 * it doesn't blank the screen.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function line(obj: unknown): Uint8Array {
  return new TextEncoder().encode(ndjsonLine(obj));
}

export async function POST(request: Request): Promise<Response> {
  // 1. Parse + validate the request body.
  let id: string;
  let decision: "approve" | "reject" | undefined;
  try {
    const body: unknown = await request.json();
    const parsed = RunRequest.parse(body);
    id = parsed.id;
    decision = parsed.decision;
  } catch {
    return Response.json(
      { error: "Body must be { id: string, decision?: \"approve\" | \"reject\" }." },
      { status: 400 },
    );
  }
  // The reviewer's decision maps to the workflow's humanApproval input. No
  // decision → "pending" (an exception pauses for a human). "approve"/"reject"
  // are phase-2 resumes. Recomputing the cheap deterministic prefix instead of
  // restoring a persisted snapshot is what keeps the human-in-the-loop stateless.
  const humanApproval = decision ?? "pending";

  // 2. Load the seeded document bundle (READ ONLY). Done before opening the
  //    stream so a missing invoice / missing DB config is a clean HTTP error
  //    rather than a half-streamed response.
  let bundle: Awaited<ReturnType<typeof loadRunBundle>>;
  try {
    bundle = await loadRunBundle(id);
  } catch (err) {
    const message =
      err instanceof Error && err.message.includes("DATABASE_URL")
        ? "Server is missing DATABASE_URL. Point it at Supabase (see README)."
        : "Could not load the invoice from the database.";
    return Response.json({ error: message }, { status: 500 });
  }
  if (!bundle) {
    return Response.json({ error: `No seeded invoice with id "${id}".` }, { status: 404 });
  }

  // 3. Stream the workflow run.
  const startedAt = Date.now();
  let seq = 0;
  const stamp = (e: Omit<TraceEvent, "seq" | "atMs">): TraceEvent => ({
    ...e,
    seq: seq++,
    atMs: Date.now() - startedAt,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: Omit<TraceEvent, "seq" | "atMs">) =>
        controller.enqueue(line(stamp(e)));

      try {
        const workflow = mastra.getWorkflow("p2p");
        const run = await workflow.createRun();
        const result = run.stream({
          inputData: {
            invoice: bundle.invoice,
            purchaseOrder: bundle.purchaseOrder,
            goodsReceipt: bundle.goodsReceipt,
            priorInvoiceNumbers: bundle.priorInvoiceNumbers,
            humanApproval,
          },
        });

        // Relay Mastra's native event stream, adapting each chunk to a TraceEvent.
        // Unrecognized/internal chunks map to null and are dropped.
        const reader = result.fullStream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const event = toTraceEvent(value);
          if (event) emit(event);
        }
      } catch (err) {
        // Surface any unexpected failure as a red trace step instead of tearing
        // down the stream — the UI shows the error in context.
        const message =
          err instanceof Error ? err.message : "Unexpected pipeline error.";
        emit(pipelineErrorEvent(message));
      } finally {
        const done: StreamDone = { done: true, durationMs: Date.now() - startedAt };
        controller.enqueue(line(done));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": STREAM_CONTENT_TYPE,
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering so chunks reach the browser immediately.
      "x-accel-buffering": "no",
    },
  });
}
