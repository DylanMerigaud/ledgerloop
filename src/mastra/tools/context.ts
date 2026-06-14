import type {
  Invoice,
  PurchaseOrder,
  GoodsReceipt,
  MatchResult,
  ApprovalDecision,
} from "@/lib/schema";

/**
 * The keys the workflow injects into each agent's `requestContext` before
 * calling it. The agents' tools READ their inputs from here rather than from
 * model-generated arguments — so the tool genuinely fires (a real `tool-call`
 * event in the trace) while the data it computes on is the trusted, server-side
 * document bundle, never something the model could hallucinate. This is the
 * "agents call tools, but the decision stays deterministic" pattern made real.
 *
 * Keyed by a typed record so `requestContext.get(...)` is type-safe on both ends.
 */
export interface ToolContext {
  /** For the matching tool. */
  matchInput: {
    invoice: Invoice;
    purchaseOrder: PurchaseOrder | null;
    goodsReceipt: GoodsReceipt | null;
    priorInvoiceNumbers: string[];
  };
  /** For the approval tool. */
  matchResult: MatchResult;
  /** For the reconciliation tool. */
  reconInput: {
    decision: ApprovalDecision;
    match: MatchResult;
    vendor: string;
  };
}

export const CTX = {
  matchInput: "matchInput",
  matchResult: "matchResult",
  reconInput: "reconInput",
} as const;
