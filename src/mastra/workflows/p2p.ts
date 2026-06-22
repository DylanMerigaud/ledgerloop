import { z } from "zod";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { RequestContext } from "@mastra/core/request-context";
import {
  Invoice,
  PurchaseOrder,
  GoodsReceipt,
  MatchResult,
  Investigation,
  ApprovalDecision,
  ReconResult,
} from "@/lib/schema";
import { runMatch } from "@/lib/matching";
import { routeApproval } from "@/lib/policy";
import { reconcile } from "@/lib/erp";
import { runInvestigation, type InvestigatorAgent } from "@/lib/investigation";
import { renderInvoicePdfBase64 } from "@/lib/invoice-pdf";
import { extractInvoice } from "@/lib/extract";
import { CTX } from "../tools/context";

/**
 * The procure-to-pay workflow — the showcase.
 *
 *   intake → matching → ┌─ exception → INVESTIGATE (agent) → approval ─┐→ reconciliation
 *                       ├─ duplicate → block ────────────────────────┤
 *                       └─ clean (straight-through) ──────────────────┘
 *
 * The decisions are DETERMINISTIC. Matching, approval tiering, and reconciliation
 * are pure, unit-tested functions — payment outcomes must be exact and
 * repeatable, never a model's guess. Those steps narrate with a templated line;
 * no LLM is called for them (no latency, no tokens, no chance of drift).
 *
 * The one place an agent earns its keep is the EXCEPTION INVESTIGATION: when the
 * matcher flags a variance, whether it's a legitimate price increase or an
 * overcharge is a judgment over messy, unstructured records, and which records
 * matter depends on what you find — an open-ended trajectory you can't hard-code.
 * So that step runs the investigator agent, which CHOOSES its tools and forms a
 * recommendation for the human. It decides nothing about the money; the reviewer
 * does. Autonomy lives off the critical path, which is exactly where it's safe.
 */

/* The state the workflow is seeded with — produced by the DB read layer. The
   optional `humanApproval` is the reviewer's decision for invoices that need a
   human gate: "pending" (run pauses at reconciliation), "approve", or "reject".
   Clean and duplicate invoices ignore it. */
const RunInput = z.object({
  invoice: Invoice,
  purchaseOrder: PurchaseOrder.nullable(),
  goodsReceipt: GoodsReceipt.nullable(),
  priorInvoiceNumbers: z.array(z.string()),
  humanApproval: z.enum(["pending", "approve", "reject"]).default("pending"),
  /* On a phase-2 resume the document was already read in phase 1 — skip the
     vision call so an approve/reject doesn't re-extract (wasted cost + latency). */
  skipExtraction: z.boolean().default(false),
});

/* A narration field every stage adds for the trace. */
const Narrated = z.object({ narration: z.string() });

/* Hard cap on the extraction call so a slow model never stalls a run. */
const EXTRACTION_TIMEOUT_MS = 20_000;

/* ── Step 1: Intake (document extraction) ───────────────────────────────────
   The first workflow step: render the invoice to a PDF and have the vision model
   read it back into structured data. This is one of the two AI touch-points (the
   other is the exception investigator); the rest of the pipeline is deterministic.

   Deliberate split: the extraction is SHOWN (the reveal proves the read happened),
   but the pipeline downstream runs on the TRUSTED seeded record, so a model
   misread degrades the reveal, never the verdicts — the seeded edge cases stay
   reliable. So intake passes the input through UNCHANGED to matching, and only
   surfaces what it extracted for the trace. Fails open: a timeout/error just
   notes it and proceeds on the record.

   The reveal needs the document on screen the instant the run starts (before the
   model returns), so we write an `intake-document` chunk early via the stream
   writer; the step's final output then carries `{ extracted, matches }`. */
const IntakeOut = RunInput.merge(Narrated).merge(
  z.object({
    extracted: Invoice.nullable(),
    matches: z.boolean(),
  }),
);
const intakeStep = createStep({
  id: "intake",
  inputSchema: RunInput,
  outputSchema: IntakeOut,
  execute: async ({ inputData, writer }) => {
    const seed = inputData.invoice;

    // Phase-2 resume: the document was already read in phase 1, so skip the vision
    // call and pass straight through (the reveal from phase 1 still stands).
    if (inputData.skipExtraction) {
      return { ...inputData, extracted: null, matches: false, narration: "" };
    }

    // Show the document immediately (the on-screen twin of the PDF being read).
    try {
      await writer?.write({
        type: "intake-document",
        payload: { document: seed },
      });
    } catch {
      /* ignore writer errors — never let the trace affect the result */
    }

    let extracted: Invoice | null = null;
    let matches = false;
    let narration =
      "Couldn't extract the document just now; proceeding on the seeded record.";
    try {
      const pdfBase64 = await renderInvoicePdfBase64(seed);
      const result = await Promise.race([
        extractInvoice(pdfBase64),
        new Promise<{ ok: false; kind: "timeout" }>((resolve) =>
          setTimeout(
            () => resolve({ ok: false, kind: "timeout" }),
            EXTRACTION_TIMEOUT_MS,
          ),
        ),
      ]);
      if (result.ok) {
        extracted = result.invoice;
        // Did the model's read agree with the seeded record on the fields the
        // pipeline routes on? (Drives the "reconciled with PO record" note.)
        matches =
          result.invoice.invoiceNumber === seed.invoiceNumber &&
          (result.invoice.poNumber ?? null) === (seed.poNumber ?? null) &&
          Math.abs(result.invoice.total - seed.total) < 0.01;
        narration = matches
          ? "Extracted and reconciled with the PO record."
          : "Extracted; key fields differ from the record (pipeline uses the record).";
      }
    } catch {
      /* fail open — narration already set to the fallback */
    }

    // Pass the input through unchanged (matching runs on the trusted record);
    // `extracted`/`matches` ride along only for the trace/reveal.
    return { ...inputData, extracted, matches, narration };
  },
});

/* ── Step 2: Matching ───────────────────────────────────────────────────────
   The authoritative verdict comes from the pure matcher; its `verdict` drives the
   branch below. We carry the vendor + the reviewer's decision forward. */
const HumanApproval = z.object({
  humanApproval: z.enum(["pending", "approve", "reject"]),
});
const MatchStepOut = MatchResult.merge(Narrated)
  .merge(z.object({ vendor: z.string() }))
  .merge(HumanApproval);
const matchingStep = createStep({
  id: "matching",
  inputSchema: IntakeOut,
  outputSchema: MatchStepOut,
  execute: async ({ inputData }) => {
    const match = runMatch({
      invoice: inputData.invoice,
      purchaseOrder: inputData.purchaseOrder,
      goodsReceipt: inputData.goodsReceipt,
      priorInvoiceNumbers: inputData.priorInvoiceNumbers,
    });
    return {
      ...match,
      vendor: inputData.invoice.vendor,
      humanApproval: inputData.humanApproval,
      narration: matchLine(match),
    };
  },
});

function matchLine(m: MatchResult): string {
  if (m.verdict === "duplicate") {
    return `${m.invoiceNumber} is a duplicate — blocking to prevent a double payment.`;
  }
  if (m.verdict === "clean") {
    return `Clean ${m.matchType === "three_way" ? "3-way" : "2-way"} match — eligible for straight-through processing.`;
  }
  return `${m.exceptions.length} exception(s) found (max ${(m.maxVariancePct * 100).toFixed(1)}% variance).`;
}

interface MastraLike {
  getAgent: (id: string) => InvestigatorAgent | undefined;
}
interface ChunkWriter {
  write: (chunk: unknown) => Promise<void>;
}

/**
 * Run the investigator agent over a flagged match and surface its tool calls on
 * the live trace. Returns the recommendation, or `null` if there's no agent / the
 * call fails — the pipeline degrades gracefully (it proceeds to approval without
 * the note). The agent-running + parsing lives in `lib/investigation.ts`, shared
 * with the eval harness; here we add only the workflow-stream concern.
 */
async function investigate(
  mastra: MastraLike | undefined,
  writer: ChunkWriter | undefined,
  match: MatchResult,
  vendor: string,
): Promise<Investigation | null> {
  try {
    const agent = mastra?.getAgent("investigator");
    if (!agent) return null;

    const requestContext = new RequestContext();
    requestContext.set(CTX.investigation, { vendor });

    const out = await runInvestigation(agent, match, vendor, requestContext);
    if (!out) return null;

    // Surface each tool the agent chose on the live trace (sub-agent tool events
    // don't bubble up into the workflow stream on their own).
    for (const toolName of out.toolsUsed) {
      try {
        await writer?.write({ type: "tool-call", payload: { toolName } });
      } catch {
        /* ignore writer errors — never let the trace affect the result */
      }
    }
    return out.investigation;
  } catch {
    return null;
  }
}

/* ── Branch steps ───────────────────────────────────────────────────────────
   Every branch ends producing the SAME shape — { decision, match, vendor,
   humanApproval } (plus narration) — so the post-branch .map() can normalise to
   one ApprovalDecision regardless of which path ran. */
const BranchOut = z.object({
  decision: ApprovalDecision,
  match: MatchResult,
  vendor: z.string(),
  humanApproval: z.enum(["pending", "approve", "reject"]),
});

/* Exception path: FIRST the investigator agent (the one open-ended, agentic step)
   reads messy vendor records and recommends how to read the variance; its note is
   written to the trace as its own node. THEN deterministic policy decides the
   approver tier. The agent informs the human; it never decides the tier. */
const investigateAndRouteStep = createStep({
  id: "approval", // stage = approval on the trace; the investigation is a sub-node
  inputSchema: MatchStepOut,
  outputSchema: BranchOut.merge(Narrated),
  execute: async ({ inputData, mastra, writer }) => {
    const { vendor, humanApproval, narration: _prior, ...match } = inputData;

    // `mastra`/`writer` are cast to our minimal contracts — we only use a tiny,
    // stable slice of each (getAgent → generate; writer.write), and keeping the
    // local interfaces means `investigate` stays unit-testable with a fake.
    const investigation = await investigate(
      mastra as unknown as MastraLike | undefined,
      writer as unknown as ChunkWriter | undefined,
      match,
      vendor,
    );
    if (investigation) {
      // Surface the agent's recommendation as its own trace node, before routing.
      try {
        await writer?.write({
          type: "investigation",
          payload: { investigation },
        });
      } catch {
        /* ignore writer errors */
      }
    }

    const decision = routeApproval(match);
    return {
      decision,
      match,
      vendor,
      humanApproval,
      narration: decision.reason,
    };
  },
});

/* Duplicate path: a control failure, not a pricing question — nothing to
   investigate. The blocked decision is surfaced directly. */
const blockStep = createStep({
  id: "approval-blocked", // same stage; a duplicate is a (blocked) approval outcome
  inputSchema: MatchStepOut,
  outputSchema: BranchOut.merge(Narrated),
  execute: async ({ inputData }) => {
    const { vendor, humanApproval, narration: _prior, ...match } = inputData;
    const decision = routeApproval(match);
    return {
      decision,
      match,
      vendor,
      humanApproval,
      narration: decision.reason,
    };
  },
});

/* Clean path: auto-approve. routeApproval returns the `auto` decision for a clean
   verdict; we surface it directly so the trace shows the STP path. */
const autoApproveStep = createStep({
  id: "approval-auto",
  inputSchema: MatchStepOut,
  outputSchema: BranchOut.merge(Narrated),
  execute: async ({ inputData }) => {
    const { vendor, humanApproval, narration: _prior, ...match } = inputData;
    const decision = routeApproval(match);
    return {
      decision,
      match,
      vendor,
      humanApproval,
      narration:
        "Auto-approved — clean match, no human approval required (straight-through).",
    };
  },
});

/* ── Step 4: Reconciliation ─────────────────────────────────────────────────
   Posts (or refuses to post) via the fake ERP. Deterministic. Final output. */
const reconciliationStep = createStep({
  id: "reconciliation",
  inputSchema: BranchOut,
  outputSchema: ReconResult.merge(Narrated),
  execute: async ({ inputData }) => {
    const { decision, match, vendor, humanApproval } = inputData;
    const recon = await reconcile(decision, match, vendor, humanApproval);
    return { ...recon, narration: recon.note };
  },
});

/* ── The wired workflow ─────────────────────────────────────────────────────
   intake → matching → branch(exception→investigate→approval | clean) →
   normalise → reconciliation. The conditions read the matching verdict. */
export const p2pWorkflow = createWorkflow({
  id: "p2p",
  inputSchema: RunInput,
  outputSchema: ReconResult.merge(Narrated),
})
  .then(intakeStep)
  .then(matchingStep)
  .branch([
    // Exception → investigate (agent) then route to Approval.
    [
      async ({ inputData }) => inputData.verdict === "exception",
      investigateAndRouteStep,
    ],
    // Duplicate → blocked, nothing to investigate (a control failure).
    [async ({ inputData }) => inputData.verdict === "duplicate", blockStep],
    // Clean → auto-approve, skip the human step.
    [async ({ inputData }) => inputData.verdict === "clean", autoApproveStep],
  ])
  // Normalise the branch output (keyed by the executed step's id) back to one
  // BranchOut so reconciliation has a single, uniform input.
  .map(async ({ inputData }) => {
    const branch = inputData as Record<
      string,
      z.infer<typeof BranchOut> | undefined
    >;
    const picked =
      branch["approval"] ??
      branch["approval-blocked"] ??
      branch["approval-auto"];
    if (!picked) {
      throw new Error("No approval branch produced an output");
    }
    return picked;
  })
  .then(reconciliationStep)
  .commit();
