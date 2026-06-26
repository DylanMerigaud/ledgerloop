import { RPCHandler } from "@orpc/server/fetch";

import { router } from "@/lib/orpc/router";

/**
 * The single mount point for the whole oRPC API. One catch-all route serves every
 * procedure (onboarding, editWorkflow, run) under /rpc. Node runtime + a 60s cap
 * because the Postgres driver needs TCP and a run can take a vision call + an agent
 * call; the same constraints the old per-route handlers had.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = new RPCHandler(router);

const handle = async (request: Request): Promise<Response> => {
  const { response } = await handler.handle(request, {
    prefix: "/rpc",
    context: { headers: request.headers },
  });
  return response ?? new Response("Not found", { status: 404 });
};

export const GET = handle;
export const POST = handle;
