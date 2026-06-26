import { desc, eq } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { agentRuns } from "@/db/schema";
import { log } from "@/lib/logger";
import { TraceEvent } from "@/lib/trace";

/**
 * The audit log — the ONE place the app writes (append-only). At the end of every
 * run the stream calls `saveAgentRun` with the collected trace + the run's final
 * verdict/outcome; the "recent runs" history view reads them back, and the nightly
 * reset clears them. Writing is BEST-EFFORT: a failure is swallowed (logged) so a
 * DB hiccup degrades the audit trail instead of breaking the live run — the same
 * graceful-degradation discipline as the rate-limiter.
 *
 * It never writes the document tables or the ERP/HRIS, so a saved run can't change
 * a future run's verdict. That's what lets us persist without the daily reset
 * having to touch any external system.
 */

export type SaveAgentRunInput = {
  invoiceNumber: string;
  /** "clean" / "exception" / "duplicate" — the matching verdict. */
  verdict: string;
  /** "posted" / "awaiting" / "rejected" / "blocked" — the reconciliation outcome. */
  outcome: string;
  trace: TraceEvent[];
  durationMs: number;
  model: string;
};

export const saveAgentRun = async (
  input: SaveAgentRunInput,
  db: Database = getDb(),
): Promise<void> => {
  try {
    await db.insert(agentRuns).values({
      // A unique id per run — invoice number + the run's wall-clock start makes it
      // sortable and collision-free across concurrent visitors.
      id: `${input.invoiceNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      invoiceNumber: input.invoiceNumber,
      verdict: input.verdict,
      tier: input.outcome,
      trace: input.trace,
      durationMs: input.durationMs,
      model: input.model,
    });
  } catch (err) {
    // Never let an audit-write failure surface to the visitor mid-run.
    log.warn("saveAgentRun failed (audit log skipped)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

/** A recent-run row for the history view — light, list-shaped. */
export type RunHistoryItem = {
  id: string;
  invoiceNumber: string;
  verdict: string;
  outcome: string;
  durationMs: number;
  createdAt: string;
};

/**
 * The most recent runs, newest first, for the dashboard history view. Validates
 * each stored trace back through Zod when a single run is loaded for replay (see
 * `loadAgentRun`); the list itself is light metadata only.
 */
export const listRecentRuns = async (
  limit = 20,
  db: Database = getDb(),
): Promise<RunHistoryItem[]> => {
  const rows = await db
    .select({
      id: agentRuns.id,
      invoiceNumber: agentRuns.invoiceNumber,
      verdict: agentRuns.verdict,
      tier: agentRuns.tier,
      durationMs: agentRuns.durationMs,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    verdict: r.verdict,
    outcome: r.tier,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
  }));
};

/**
 * Load one stored run's full trace for replay — the history view re-renders this
 * exact `TraceEvent[]` with no model call (zero tokens). Validates the stored
 * trace through Zod at the DB boundary (same single-source-of-truth discipline as
 * the read layer); a drifted row yields `null` rather than a bad render.
 */
export const loadAgentRun = async (
  id: string,
  db: Database = getDb(),
): Promise<{ invoiceNumber: string; trace: TraceEvent[] } | null> => {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  if (!row) return null;
  const trace = TraceEvent.array().safeParse(row.trace);
  if (!trace.success) return null;
  return { invoiceNumber: row.invoiceNumber, trace: trace.data };
};
