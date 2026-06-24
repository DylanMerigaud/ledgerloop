import { z } from "zod";

import { ApprovalWorkflow } from "@/lib/approval-workflow";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";
import { proposeEdit } from "@/lib/workflow-edit";
import { anthropicEditModel } from "@/lib/workflow-edit-model";

/**
 * POST /api/workflow/edit — propose a conversational edit to an approval workflow.
 *
 * Body: { workflow: ApprovalWorkflow, instruction: string }. Returns the PROPOSED
 * workflow plus the diff vs the current one. Nothing is persisted or applied — the
 * client shows the diff and the human approves (swaps it in) or reverts (discards).
 * The pipeline only ever runs the workflow the human has approved.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const EditRequest = z.object({
  workflow: ApprovalWorkflow,
  instruction: z.string().trim().min(1, "an instruction is required"),
});

export async function POST(request: Request): Promise<Response> {
  const ip = clientIpFrom(request.headers);
  const verdict = await checkRateLimit(ip);
  if (!verdict.ok) {
    return Response.json(
      { error: "Rate limit hit — try again shortly." },
      {
        status: 429,
        headers: { "retry-after": String(verdict.retryAfterSeconds) },
      },
    );
  }

  let workflow: z.infer<typeof EditRequest>["workflow"];
  let instruction: string;
  try {
    const parsed = EditRequest.parse(await request.json());
    workflow = parsed.workflow;
    instruction = parsed.instruction;
  } catch {
    return Response.json(
      { error: "Body must be { workflow, instruction }." },
      { status: 400 },
    );
  }

  try {
    const { proposed, changes } = await proposeEdit(
      anthropicEditModel,
      workflow,
      instruction,
    );
    return Response.json({ proposed, changes });
  } catch {
    // A validation failure (the model produced an invalid graph) or a model error
    // both land here — the edit is simply not offered, the current workflow stands.
    return Response.json(
      {
        error:
          "Could not produce a valid edit for that instruction. The current workflow is unchanged — try rephrasing.",
      },
      { status: 422 },
    );
  }
}
