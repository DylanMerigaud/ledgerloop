import { ORPCError } from "@orpc/server";

import { loadRunBundle } from "@/db/client";
import { saveAgentRun } from "@/db/runs";
import { type RunRequest, type StreamDone } from "@/lib/api-types";
import { isRecord } from "@/lib/assert";
import {
  DEFAULT_TOLERANCES,
  DEFAULT_APPROVAL_POLICY,
} from "@/lib/client-profile";
import { toTraceEvent, pipelineErrorEvent, type TraceEvent } from "@/lib/trace";
import { mastra } from "@/src/mastra";
import { PIPELINE_MODEL } from "@/src/mastra/model";

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

  // Accumulated for the audit row written at the end of the run.
  const collected: TraceEvent[] = [];
  let verdict = "unknown";
  let outcome = "unknown";

  try {
    const workflow = mastra.getWorkflow("p2p");
    const wfRun = await workflow.createRun();
    const result = wfRun.stream({
      inputData: {
        invoice: bundle.invoice,
        purchaseOrder: bundle.purchaseOrder,
        goodsReceipt: bundle.goodsReceipt,
        priorInvoiceNumbers: bundle.priorInvoiceNumbers,
        postedBillKeys: bundle.postedBillKeys,
        inactiveVendors: bundle.inactiveVendors,
        catalogSkus: bundle.catalogSkus,
        decisions,
        skipExtraction: hasDecisions,
        // The activated workflow IS what the pipeline routes through — this is the
        // link between onboarding (where it's derived/edited) and the run. It's
        // passed in, never persisted (the run stays stateless). Tolerances stay at
        // the defaults; the workflow is the per-client lever the demo turns. When
        // `input.workflow` is undefined the pipeline's `workflowFor` falls back to
        // the policy-derived default DAG, so a run without a workflow behaves as
        // before.
        profile: {
          id: "active",
          name: input.workflow?.name ?? "Default workflow",
          tolerances: DEFAULT_TOLERANCES,
          approvalPolicy: DEFAULT_APPROVAL_POLICY,
          workflow: input.workflow,
        },
      },
    });

    // Relay Mastra's native event stream, adapting each chunk to a TraceEvent;
    // unrecognized/internal chunks map to null and are dropped. We also collect the
    // emitted events + the final verdict/outcome so the run can be persisted as an
    // audit row once it completes.
    const reader = result.fullStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const event = toTraceEvent(value);
      if (!event) continue;
      const stamped = stamp(event);
      collected.push(stamped);
      // The matching stage's data carries the verdict; the reconciliation/approval
      // stage carries the outcome. Capture them as they pass for the audit row.
      if (isRecord(stamped.data)) {
        const d = stamped.data;
        if (typeof d["verdict"] === "string") verdict = d["verdict"];
        if (typeof d["outcome"] === "string") outcome = d["outcome"];
      }
      yield stamped;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unexpected pipeline error.";
    const errEvent = stamp(pipelineErrorEvent(message));
    collected.push(errEvent);
    yield errEvent;
  }

  const durationMs = Date.now() - startedAt;

  // Persist the run as an append-only audit row. Best-effort (saveAgentRun never
  // throws), never touches the document tables or the ERP/HRIS — so it can't
  // change a future run's verdict. The nightly reset clears these.
  await saveAgentRun({
    invoiceNumber: bundle.invoice.invoiceNumber,
    verdict,
    outcome,
    trace: collected,
    durationMs,
    model: PIPELINE_MODEL,
  });

  yield { done: true, durationMs };
};
