import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import {
  vendorPriceHistory,
  vendorPoNotes,
  vendorReceiptNotes,
} from "@/lib/vendor-context";
import { CTX, type ToolContext } from "./context";

/**
 * Tools for the EXCEPTION INVESTIGATOR agent.
 *
 * Unlike the deterministic stages (match / route / reconcile), this agent runs an
 * OPEN-ENDED loop: given a flagged exception, it decides which of these records to
 * pull, in what order, and when it has enough to form a recommendation. The path
 * isn't knowable in advance — that's what makes an agent the right tool here.
 *
 * Each tool returns deliberately MESSY, free-text data (the imperfect data a real
 * AP team actually has). The agent reads it like a human would. The vendor whose
 * records to read is taken from `requestContext` (server-trusted), not from
 * model-supplied arguments — so the agent can't pull the wrong vendor's file.
 *
 * Nothing these tools return is a decision. The agent's output is a
 * RECOMMENDATION shown to the human before they approve or reject; the money
 * decision stays with the reviewer, and the routing stays deterministic.
 */

function vendorFromContext(context: unknown): string {
  const ctx = context as
    | { requestContext?: { get: (k: string) => unknown } }
    | undefined;
  const vendor = ctx?.requestContext?.get(CTX.investigation) as
    | ToolContext["investigation"]
    | undefined;
  if (!vendor) {
    throw new Error("investigator tool: no investigation context set");
  }
  return vendor.vendor;
}

export const priceHistoryTool = createTool({
  id: "get-vendor-price-history",
  description:
    "Pull the buyer's free-text price history and account notes for this vendor — past quoted prices, any surcharge or price-increase notices, and prior billing disputes. Use this to judge whether a price variance is a legitimate increase or an overcharge. Takes no arguments.",
  inputSchema: z.object({}),
  outputSchema: z.object({ vendor: z.string(), priceHistory: z.string() }),
  execute: async (_input, context) => {
    const vendor = vendorFromContext(context);
    return { vendor, priceHistory: vendorPriceHistory(vendor) };
  },
});

export const poNotesTool = createTool({
  id: "get-po-notes",
  description:
    "Read the buyer's free-text notes attached to this vendor's purchase order — intent, side agreements, and any standing guidance on how to handle variances. Use this to see whether the exception was already anticipated. Takes no arguments.",
  inputSchema: z.object({}),
  outputSchema: z.object({ vendor: z.string(), poNotes: z.string() }),
  execute: async (_input, context) => {
    const vendor = vendorFromContext(context);
    return { vendor, poNotes: vendorPoNotes(vendor) };
  },
});

export const receiptNotesTool = createTool({
  id: "get-receipt-notes",
  description:
    "Read the warehouse / receiving notes for this vendor's delivery — what was actually received and any remarks the receiver wrote (damage, partial delivery, price addenda on the delivery slip). Takes no arguments.",
  inputSchema: z.object({}),
  outputSchema: z.object({ vendor: z.string(), receiptNotes: z.string() }),
  execute: async (_input, context) => {
    const vendor = vendorFromContext(context);
    return { vendor, receiptNotes: vendorReceiptNotes(vendor) };
  },
});
