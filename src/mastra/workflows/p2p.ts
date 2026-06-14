import { z } from "zod";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import {
  Invoice,
  PurchaseOrder,
  GoodsReceipt,
  MatchResult,
  ApprovalDecision,
  ReconResult,
} from "@/lib/schema";
import { runMatch } from "@/lib/matching";
import { routeApproval } from "@/lib/policy";
import { reconcile } from "@/lib/erp";
import { CTX } from "../tools/context";
import { runAgentStep } from "./run-agent-step";

/**
 * The procure-to-pay workflow — the showcase.
 *
 *   intake → matching → ┌─ exception/duplicate → approval ─┐→ reconciliation
 *                       └─ clean (straight-through) ───────┘
 *
 * The VALUE on display is the orchestration + CONDITIONAL ROUTING: when matching
 * returns a price/quantity/duplicate exception, the run branches through the
 * Approval agent; a clean match skips approval and goes straight to
 * reconciliation. That branch is the `.branch(...)` below — the thing a CTO must
 * see to believe this is real multi-agent orchestration.
 *
 * Pattern note (Mastra): each step does its DECISION with a pure, tested function
 * (runMatch / routeApproval / reconcile) for reliability, then calls its Agent to
 * NARRATE the result via `mastra.getAgent(...).generate(...)`. The structured
 * result is what routes the workflow; the narration is what the live trace shows.
 * Agents narrate; deterministic rules decide — so the seeded edge cases always
 * behave on stage. Each step is also defensive: if the LLM narration fails, the
 * step still returns its (valid) structured result with a fallback line, so a
 * flaky model never breaks the pipeline — it just loses some prose.
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
});

/* A narration field every stage adds for the trace. */
const Narrated = z.object({ narration: z.string() });

/** Safely get a one-line narration from an agent; never throws. */
async function narrate(
  mastra: { getAgent: (id: string) => { generate: (p: string) => Promise<{ text?: string }> } } | undefined,
  agentId: string,
  prompt: string,
  fallback: string,
): Promise<string> {
  try {
    const agent = mastra?.getAgent(agentId);
    if (!agent) return fallback;
    const res = await agent.generate(prompt);
    const text = (res.text ?? "").trim();
    return text.length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
}

/* ── Step 1: Intake ─────────────────────────────────────────────────────────
   Confirms the invoice and produces an intake summary line. Passes the full
   document bundle through unchanged for the matcher. */
const intakeStep = createStep({
  id: "intake",
  inputSchema: RunInput,
  outputSchema: RunInput.merge(Narrated),
  execute: async ({ inputData, mastra }) => {
    const { invoice } = inputData;
    const narration = await narrate(
      mastra,
      "intake",
      `Invoice received: vendor ${invoice.vendor}, number ${invoice.invoiceNumber}, ${invoice.lineItems.length} line item(s), total ${invoice.total} ${invoice.currency}. Confirm receipt in one sentence.`,
      `Received ${invoice.invoiceNumber} from ${invoice.vendor}: ${invoice.lineItems.length} line(s), ${invoice.total} ${invoice.currency}.`,
    );
    return { ...inputData, narration };
  },
});

/* ── Step 2: Matching ───────────────────────────────────────────────────────
   The authoritative verdict comes from runMatch(); the agent narrates it. The
   verdict drives the branch below. We carry the documents we still need
   (vendor) forward alongside the MatchResult. */
const HumanApproval = z.object({
  humanApproval: z.enum(["pending", "approve", "reject"]),
});
const MatchStepOut = MatchResult.merge(Narrated)
  .merge(z.object({ vendor: z.string() }))
  .merge(HumanApproval);
const matchingStep = createStep({
  id: "matching",
  inputSchema: RunInput.merge(Narrated),
  outputSchema: MatchStepOut,
  execute: async ({ inputData, mastra, writer }) => {
    const matchInput = {
      invoice: inputData.invoice,
      purchaseOrder: inputData.purchaseOrder,
      goodsReceipt: inputData.goodsReceipt,
      priorInvoiceNumbers: inputData.priorInvoiceNumbers,
    };
    // The Matching agent calls run-match (a real tool-call); the tool reads
    // `matchInput` from requestContext and runs the pure matcher. The verdict is
    // computed deterministically here and is authoritative; the agent narrates it.
    const match = runMatch(matchInput);
    const { narration } = await runAgentStep({
      mastra,
      writer,
      agentId: "matching",
      toolName: "run-match",
      context: { [CTX.matchInput]: matchInput },
      result: match,
      fallbackNarration: defaultMatchLine,
      prompt:
        "An invoice is ready for matching. Call the run-match tool to compute the verdict, then describe the outcome in one concise sentence (name the discrepancy and line if there's an exception; say it's a duplicate if blocked).",
    });

    return {
      ...match,
      vendor: inputData.invoice.vendor,
      humanApproval: inputData.humanApproval,
      narration,
    };
  },
});

function defaultMatchLine(m: MatchResult): string {
  if (m.verdict === "duplicate") {
    return `${m.invoiceNumber} is a duplicate — blocking to prevent a double payment.`;
  }
  if (m.verdict === "clean") {
    return `Clean ${m.matchType === "three_way" ? "3-way" : "2-way"} match — eligible for straight-through processing.`;
  }
  return `${m.exceptions.length} exception(s) found (max ${(m.maxVariancePct * 100).toFixed(1)}% variance).`;
}

/* ── Branch steps ───────────────────────────────────────────────────────────
   Both branches end producing the SAME shape — { decision, match, vendor } — so
   the post-branch .map() can normalise to one ApprovalDecision regardless of
   which path ran. */
const BranchOut = z.object({
  decision: ApprovalDecision,
  match: MatchResult,
  vendor: z.string(),
  humanApproval: z.enum(["pending", "approve", "reject"]),
});

/* Exception/duplicate path: the Approval agent routes + narrates. */
const approvalStep = createStep({
  id: "approval",
  inputSchema: MatchStepOut,
  outputSchema: BranchOut.merge(Narrated),
  execute: async ({ inputData, mastra, writer }) => {
    const { vendor, humanApproval, narration: _prior, ...match } = inputData;
    // The Approval agent calls route-approval (a real tool-call); the tool reads
    // the MatchResult from requestContext and applies the pure policy. The tier
    // is computed deterministically here and is authoritative; the agent narrates.
    const decision = routeApproval(match);
    const { narration } = await runAgentStep({
      mastra,
      writer,
      agentId: "approval",
      toolName: "route-approval",
      context: { [CTX.matchResult]: match },
      result: decision,
      fallbackNarration: (d) => d.reason,
      prompt:
        "An invoice failed straight-through matching. Call the route-approval tool to determine the approver tier, then state who must approve it (or that it's blocked as a duplicate) in one concise sentence.",
    });
    return { decision, match, vendor, humanApproval, narration };
  },
});

/* Clean path: auto-approve WITHOUT an LLM call (it's straight-through by policy,
   nothing to deliberate). routeApproval already returns the `auto` decision for a
   clean verdict; we surface it directly so the trace shows the STP path. */
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
      narration: "Auto-approved — clean match, no human approval required (straight-through).",
    };
  },
});

/* ── Step 4: Reconciliation ─────────────────────────────────────────────────
   Posts (or refuses to post) via the fake ERP, then narrates. Final output. */
const reconciliationStep = createStep({
  id: "reconciliation",
  inputSchema: BranchOut,
  outputSchema: ReconResult.merge(Narrated),
  execute: async ({ inputData, mastra, writer }) => {
    const { decision, match, vendor, humanApproval } = inputData;
    // Compute the deterministic reconciliation once — it's the guaranteed
    // fallback (the fake ERP adapter is side-effect-free, so this is safe to run
    // regardless of whether the agent also fires the tool). `humanApproval`
    // decides whether an exception is posted, held (awaiting), or rejected.
    const recon = await reconcile(decision, match, vendor, humanApproval);
    // When the invoice is HELD for a human, don't ask the agent to narrate a
    // "posted" story — surface the deterministic "awaiting approval" note and
    // skip the LLM call entirely (it would only burn tokens to restate the pause).
    if (recon.outcome === "awaiting") {
      return { ...recon, narration: recon.note };
    }
    const { narration } = await runAgentStep({
      mastra,
      writer,
      agentId: "reconciliation",
      toolName: "post-to-erp",
      context: { [CTX.reconInput]: { decision, match, vendor, humanApproval } },
      result: recon,
      fallbackNarration: (r) => r.note,
      prompt:
        "An invoice has cleared matching and approval. Call the post-to-erp tool to record the accounting outcome, then state the result (the ERP reference and amount, whether it was rejected, or that it was held un-posted) in one concise sentence.",
    });
    return { ...recon, narration };
  },
});

/* ── The wired workflow ─────────────────────────────────────────────────────
   intake → matching → branch(exception|clean) → normalise → reconciliation.
   The conditions read the matching step's verdict — the heart of the routing. */
export const p2pWorkflow = createWorkflow({
  id: "p2p",
  inputSchema: RunInput,
  outputSchema: ReconResult.merge(Narrated),
})
  .then(intakeStep)
  .then(matchingStep)
  .branch([
    // Anything that isn't a clean straight-through match goes to Approval.
    [async ({ inputData }) => inputData.verdict !== "clean", approvalStep],
    // Clean matches auto-approve and skip the human step.
    [async ({ inputData }) => inputData.verdict === "clean", autoApproveStep],
  ])
  // Normalise the branch output (keyed by the executed step's id) back to one
  // BranchOut so reconciliation has a single, uniform input.
  .map(async ({ inputData }) => {
    const branch = inputData as Record<string, z.infer<typeof BranchOut> | undefined>;
    const picked = branch["approval"] ?? branch["approval-auto"];
    if (!picked) {
      throw new Error("No approval branch produced an output");
    }
    return picked;
  })
  .then(reconciliationStep)
  .commit();
