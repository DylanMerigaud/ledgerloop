import { getDb } from "@/db/client";
import { resetAndReseed } from "@/db/reset";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";

/**
 * GET /api/reset — truncate + reseed Postgres back to the pristine demo dataset.
 *
 * Invoked once a day by a Vercel Cron (see vercel.json). This is what makes the
 * persistence safe: every run writes an append-only `agent_runs` audit row, and
 * this clears them nightly so the public demo returns to a clean queue — the
 * "pristine for the next visitor" property, kept while still having an audit trail.
 *
 * Scope: Postgres ONLY. It never touches the QuickBooks / BambooHR sandboxes
 * (those are frozen fixtures the pipeline reads, never writes), so the reset can't
 * fail on a rotated QBO token and can't desync an external system.
 *
 * Guarded by CRON_SECRET: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
 * Anything without the matching secret gets 401 — so this isn't a public truncate
 * button. If CRON_SECRET is unset, the route refuses all callers.
 *
 * Node runtime — it does real Postgres writes via the postgres-js driver.
 */
export const runtime = "nodejs";

export const GET = async (request: Request): Promise<Response> => {
  const secret = env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const counts = await resetAndReseed(getDb());
    log.info("nightly reset complete", counts);
    return Response.json({ ok: true, ...counts });
  } catch (err) {
    log.error("nightly reset failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Reset failed.", { status: 500 });
  }
};
