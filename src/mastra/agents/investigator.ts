import { Agent } from "@mastra/core/agent";

import { PIPELINE_MODEL } from "@/src/mastra/model";
import {
  priceHistoryTool,
  poNotesTool,
  receiptNotesTool,
} from "@/src/mastra/tools/investigator-tools";

/**
 * The Exception Investigator — the one genuinely agentic step in the pipeline.
 *
 * Every other stage is deterministic code: matching, approval tiering, and
 * reconciliation are pure functions, because payment decisions must be exact and
 * repeatable. This step is different. When the matcher flags an exception, a
 * number ("9% over the PO") doesn't tell a reviewer whether it's a legitimate
 * price increase or an overcharge to dispute. That answer lives in messy,
 * unstructured records, and which records matter depends on what you find — an
 * open-ended trajectory you can't hard-code. So here, and only here, an agent
 * earns its place: it CHOOSES which records to pull (via its tools), reads them
 * like a human would, and forms a recommendation.
 *
 * It DECIDES NOTHING about the money. Its output is a recommendation that the
 * human reviewer sees before they approve or reject. The agent can be wrong; the
 * human corrects it. That's the safe place for autonomy — off the critical path.
 */
export const investigatorAgent = new Agent({
  id: "investigator",
  name: "Exception investigator",
  model: PIPELINE_MODEL,
  tools: {
    "get-vendor-price-history": priceHistoryTool,
    "get-po-notes": poNotesTool,
    "get-receipt-notes": receiptNotesTool,
  },
  instructions: `You are the EXCEPTION INVESTIGATOR in an accounts-payable pipeline. A deterministic matcher has flagged an invoice with one or more variances (e.g. a unit price above the purchase order, a quantity above what was received). Your job is to help a human reviewer decide whether the flagged variance is LEGITIMATE or an OVERCHARGE/ERROR to push back on.

You have tools that pull the messy, unstructured records a real AP team keeps:
- get-vendor-price-history — past prices, surcharge notices, prior billing disputes
- get-po-notes — the buyer's free-text notes on the purchase order
- get-receipt-notes — what the warehouse actually wrote about the delivery

Investigate:
- Call the tools you judge relevant. You do not have to call all of them; pull what you need to reach a confident view, then stop.
- Read the records critically. A surcharge that was flagged in advance and is in line with the market is likely legitimate. A price jump with no notice, no contract basis, and a vendor with a history of billing slips is likely an overcharge or error.

Then give your recommendation as ONE short paragraph (max ~45 words): say whether the variance looks LEGITIMATE, an OVERCHARGE/ERROR, or UNCLEAR, and cite the specific evidence that drove it. Do not restate the numbers the matcher already has. Do not tell the reviewer to "approve" or "reject" — recommend how to read the variance; the decision is theirs.`,
});
