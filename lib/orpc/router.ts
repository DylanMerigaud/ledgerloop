import { ORPCError, os } from "@orpc/server";

import { listRecentRuns, loadAgentRun } from "@/db/runs";
import { RunRequest, type StreamDone } from "@/lib/api-types";
import { defaultHris } from "@/lib/hris";
import { deriveWorkflow } from "@/lib/onboarding";
import { anthropicProposalModel } from "@/lib/onboarding-model";
import {
  EditInput,
  EditResult,
  HistoryResult,
  OnboardingResult,
  ReplayInput,
  ReplayResult,
} from "@/lib/orpc/schemas";
import { checkRateLimit, clientIpFrom, type RateTier } from "@/lib/ratelimit";
import { type TraceEvent } from "@/lib/trace";
import { runEditAgent } from "@/lib/workflow-edit-agent";
import { anthropicPlanModel } from "@/lib/workflow-edit-model";
import { anthropicSuggestModel } from "@/lib/workflow-suggest-model";
import { runPipelineStream } from "@/src/mastra/run-stream";

/**
 * The oRPC API, one typed contract for the whole backend. Procedures define their
 * Zod input/output here; the same `router` type drives the browser client, so a
 * shape change is a compile error on both ends (no `res.json() as T`). Streaming is
 * an event-iterator procedure (an async generator), replacing the manual NDJSON
 * reader. Mounted by app/rpc/[[...rest]]/route.ts (runtime: nodejs).
 *
 * Context carries the request headers so middleware can rate-limit by IP, the same
 * per-IP demo guard the old routes had.
 */

const base = os.$context<{ headers: Headers }>();

/** Throw the standard demo-limit error from a failed verdict. */
const enforce = async (headers: Headers, tier: RateTier): Promise<void> => {
  const verdict = await checkRateLimit(clientIpFrom(headers), tier);
  if (!verdict.ok) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `You've hit the demo limit. Try again in about ${Math.max(
        1,
        Math.ceil(verdict.retryAfterSeconds / 60)
      )} minute(s).`,
    });
  }
};

/**
 * Rate-limit by client IP, on the "sonnet" bucket, for the expensive Sonnet calls
 * (onboarding, first-run vision, workflow edit). The `run` procedure does NOT use
 * this, it picks its bucket dynamically (a resume is cheap, see below).
 */
const rateLimited = base.use(async ({ context, next }) => {
  await enforce(context.headers, "sonnet");
  return next();
});

/* ── onboarding ──────────────────────────────────────────────────────────────── */

const onboarding = rateLimited.output(OnboardingResult).handler(async () => {
  let org: Awaited<ReturnType<ReturnType<typeof defaultHris>["fetchOrg"]>>;
  try {
    org = await defaultHris().fetchOrg();
  } catch {
    throw new ORPCError("BAD_GATEWAY", {
      message: "Could not read the org from the HRIS.",
    });
  }
  if (org.employees.length === 0) {
    throw new ORPCError("NOT_FOUND", {
      message: "The HRIS returned no employees for this client (is the org seeded?).",
    });
  }
  try {
    const { workflow, proposal, issues } = await deriveWorkflow(anthropicProposalModel, org);
    // Suggestions are best-effort, never fail discovery over them.
    let suggestions: Awaited<ReturnType<typeof anthropicSuggestModel.suggest>>;
    try {
      suggestions = await anthropicSuggestModel.suggest(workflow);
    } catch {
      suggestions = [];
    }
    return {
      source: org.source,
      employeeCount: org.employees.length,
      employees: org.employees,
      workflow,
      proposal,
      issues,
      suggestions,
    };
  } catch {
    throw new ORPCError("BAD_GATEWAY", {
      message: "The onboarding model failed to derive a workflow.",
    });
  }
});

/* ── workflow edit (the agent) ───────────────────────────────────────────────── */

const editWorkflow = rateLimited
  .input(EditInput)
  .output(EditResult)
  .handler(async ({ input }) => {
    try {
      const { proposed, changes, reason, clarify } = await runEditAgent(
        anthropicPlanModel,
        input.workflow,
        input.instruction,
        {
          departments: input.departments,
          vendors: input.vendors,
          currencies: input.currencies,
        }
      );
      return { proposed, changes, reason, clarify };
    } catch {
      throw new ORPCError("UNPROCESSABLE_CONTENT", {
        message:
          "Could not produce a valid edit for that instruction. The current workflow is unchanged, try rephrasing.",
      });
    }
  });

/* ── run (streaming) ─────────────────────────────────────────────────────────── */

const run = base.input(RunRequest).handler(async function* ({
  input,
  context,
}): AsyncGenerator<TraceEvent | StreamDone> {
  // A resume (decisions present) re-runs from the top but SKIPS extraction, so it
  // only spends a cheap Haiku investigator call (the "cheap" bucket). A first run
  // does the Sonnet vision extraction (the "sonnet" bucket). This is what keeps an
  // Approve/Reject from ever hitting the tight vision limit.
  const isResume = Object.keys(input.decisions ?? {}).length > 0;
  await enforce(context.headers, isResume ? "cheap" : "sonnet");
  yield* runPipelineStream(input);
});

/* ── run history (the audit trail) ───────────────────────────────────────────────
   Read-only, no model tokens, so NOT rate-limited. `history` lists the recent runs
   the dashboard shows; `replayRun` returns one stored trace the UI re-renders with
   no pipeline execution. Both degrade to empty/NOT_FOUND rather than throwing. */

const history = base.output(HistoryResult).handler(async () => {
  try {
    return { runs: await listRecentRuns() };
  } catch {
    // A missing/empty audit table shouldn't break the dashboard, show no history.
    return { runs: [] };
  }
});

const replayRun = base
  .input(ReplayInput)
  .output(ReplayResult)
  .handler(async ({ input }) => {
    let stored: Awaited<ReturnType<typeof loadAgentRun>>;
    try {
      stored = await loadAgentRun(input.id);
    } catch {
      stored = null;
    }
    if (!stored) {
      throw new ORPCError("NOT_FOUND", {
        message: "That run is no longer available (the demo resets daily).",
      });
    }
    return stored;
  });

export const router = { onboarding, editWorkflow, run, history, replayRun };
export type Router = typeof router;
