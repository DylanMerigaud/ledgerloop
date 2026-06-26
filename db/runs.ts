import { desc, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { getDb, type Database } from "@/db/client";
import { agentRuns, type AgentRunRow } from "@/db/schema";
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

/** The narrow slice `saveAgentRun` uses — `insert(table).values(row)`. Declaring it
 *  structurally (not the full `Database`) lets a test pass a tiny fake with no cast,
 *  while the real handle satisfies the same shape. */
type AuditWritableDb = {
  insert: (table: PgTable) => {
    values: (row: Record<string, unknown>) => unknown;
  };
};

export const saveAgentRun = async (
  input: SaveAgentRunInput,
  db: AuditWritableDb = getDb(),
): Promise<void> => {
  try {
    await db.insert(agentRuns).values({
      // A unique id per run — the invoice number (readable) plus a UUID so two
      // concurrent visitors running the same invoice can't collide.
      id: `${input.invoiceNumber}-${crypto.randomUUID()}`,
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

/** Map a stored row to the list-shaped history item: the DB calls the outcome
 *  column `tier` (a legacy name), the UI wants `outcome`; the timestamp becomes an
 *  ISO string. Pure — extracted so it can be unit-tested without a DB. */
export const toHistoryItem = (
  r: Pick<
    AgentRunRow,
    "id" | "invoiceNumber" | "verdict" | "tier" | "durationMs" | "createdAt"
  >,
): RunHistoryItem => ({
  id: r.id,
  invoiceNumber: r.invoiceNumber,
  verdict: r.verdict,
  outcome: r.tier,
  durationMs: r.durationMs,
  createdAt: r.createdAt.toISOString(),
});

/** Validate a stored trace blob back to `TraceEvent[]`, or `null` if it's drifted/
 *  garbage — the Zod gate at the DB read boundary. Pure, unit-testable. */
export const parseStoredTrace = (raw: unknown): TraceEvent[] | null => {
  const parsed = TraceEvent.array().safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/**
 * The most recent runs, newest first, for the dashboard history view. Light
 * metadata only; the full trace is loaded on demand by `loadAgentRun` for replay.
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
  return rows.map(toHistoryItem);
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
  const trace = parseStoredTrace(row.trace);
  if (!trace) return null;
  return { invoiceNumber: row.invoiceNumber, trace };
};
