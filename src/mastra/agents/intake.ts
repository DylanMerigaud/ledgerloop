import { Agent } from "@mastra/core/agent";
import { PIPELINE_MODEL } from "../model";

/**
 * Agent 1 — Intake.
 *
 * In a full deployment this agent parses an invoice PDF into structured line
 * items (the same job as the sibling ai-invoice-parser repo). In this demo the
 * invoices are already seeded as structured records, so intake's role is to
 * confirm the document, summarise what came in, and hand a clean, validated
 * invoice to the matcher. It has no tools — it's a focused reasoning step that
 * produces a one-line intake summary for the trace.
 */
export const intakeAgent = new Agent({
  id: "intake",
  name: "Intake agent",
  model: PIPELINE_MODEL,
  instructions: `You are the INTAKE agent in an accounts-payable pipeline. You receive a structured invoice (vendor, invoice number, currency, line items, totals) that has just entered the system.

Your job:
- Briefly confirm the invoice has been received and read.
- State the vendor, the invoice number, the line-item count, and the total in ONE concise sentence (max 25 words).
- Do not invent fields or judge whether it matches a PO — that's the next agent's job.

Respond with a single short sentence suitable for a real-time activity log. No preamble, no lists.`,
});
