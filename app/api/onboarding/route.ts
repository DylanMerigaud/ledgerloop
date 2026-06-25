import { defaultHris } from "@/lib/hris";
import { deriveWorkflow } from "@/lib/onboarding";
import { anthropicProposalModel } from "@/lib/onboarding-model";
import { checkRateLimit, clientIpFrom } from "@/lib/ratelimit";

/**
 * POST /api/onboarding — the discovery step a forward-deployed engineer runs once
 * per client. It reads the client's org from the HRIS (BambooHR, scoped to the
 * demo client's division — or the recorded sample org when no key is set), then
 * the onboarding agent derives a proposed approval workflow + flags the org's
 * data-quality issues for a human to resolve.
 *
 * Returns the normalised org, the derived conditional workflow (the DAG the
 * pipeline executes), and the issues — the payload the onboarding UI renders for
 * validation. The result is a PROPOSAL: a human approves it before it goes live.
 *
 * Runtime: NODE (the HRIS adapter and the model SDK need it). Rate-limited like
 * the run route — each call spends model tokens.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = async (request: Request): Promise<Response> => {
  const ip = clientIpFrom(request.headers);
  const verdict = await checkRateLimit(ip);
  if (!verdict.ok) {
    return Response.json(
      {
        error: `You've hit the demo limit. Try again in about ${Math.max(
          1,
          Math.ceil(verdict.retryAfterSeconds / 60),
        )} minute(s).`,
      },
      {
        status: 429,
        headers: { "retry-after": String(verdict.retryAfterSeconds) },
      },
    );
  }

  // 1. Read the client's org from the HRIS (live scoped, or recorded sample).
  let org: Awaited<ReturnType<ReturnType<typeof defaultHris>["fetchOrg"]>>;
  try {
    org = await defaultHris().fetchOrg();
  } catch {
    return Response.json(
      { error: "Could not read the org from the HRIS." },
      { status: 502 },
    );
  }
  if (org.employees.length === 0) {
    return Response.json(
      {
        error:
          "The HRIS returned no employees for this client (is the org seeded?).",
      },
      { status: 404 },
    );
  }

  // 2. The onboarding agent derives the workflow + explains the issues.
  try {
    const { workflow, proposal, issues } = await deriveWorkflow(
      anthropicProposalModel,
      org,
    );
    return Response.json({
      source: org.source,
      employeeCount: org.employees.length,
      employees: org.employees,
      workflow,
      proposal,
      issues,
    });
  } catch {
    return Response.json(
      { error: "The onboarding model failed to derive a workflow." },
      { status: 502 },
    );
  }
};
