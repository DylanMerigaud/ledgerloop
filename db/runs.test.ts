import assert from "node:assert/strict";
import { test } from "node:test";

import {
  saveAgentRun,
  toHistoryItem,
  parseStoredTrace,
  type SaveAgentRunInput,
} from "@/db/runs";
import type { TraceEvent } from "@/lib/trace";

/**
 * The audit log helpers. We don't touch a real database (the suite is all-faked):
 *   • `saveAgentRun` takes a narrow structural db (insert().values()), so a fake
 *     captures the row and an exploding fake proves the write is best-effort.
 *   • `toHistoryItem` / `parseStoredTrace` are the pure logic the read functions
 *     wrap (the column rename + the Zod gate on a stored trace); the drizzle query
 *     chain around them is plumbing, tested live.
 */

const sampleTrace: TraceEvent[] = [
  {
    seq: 0,
    kind: "run",
    stage: "pipeline",
    status: "ok",
    stepId: "",
    label: "Pipeline started",
    atMs: 0,
  },
];

const input = (over: Partial<SaveAgentRunInput> = {}): SaveAgentRunInput => ({
  invoiceNumber: "INV-2042",
  verdict: "exception",
  outcome: "awaiting",
  trace: sampleTrace,
  durationMs: 1234,
  model: "anthropic/claude-haiku-4-5",
  ...over,
});

/** A capturing fake: records the inserted row, and swallows the upsert chain (the
    real write is `insert().values().onConflictDoUpdate()`). */
const capturingDb = (rows: Record<string, unknown>[]) => ({
  insert: (_table: unknown) => ({
    values: (row: Record<string, unknown>) => {
      rows.push(row);
      return { onConflictDoUpdate: (_c: unknown) => Promise.resolve() };
    },
  }),
});

test("saveAgentRun writes one row with the run's verdict/outcome/trace", async () => {
  const rows: Record<string, unknown>[] = [];
  await saveAgentRun(input(), capturingDb(rows));
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row["invoiceNumber"], "INV-2042");
  assert.equal(row["verdict"], "exception");
  // The DB column is `tier`; the outcome maps onto it.
  assert.equal(row["tier"], "awaiting");
  assert.equal(row["durationMs"], 1234);
  assert.deepEqual(row["trace"], sampleTrace);
  // No client runId → a generated id carrying the invoice number for readability.
  assert.match(String(row["id"]), /^INV-2042-/);
});

test("saveAgentRun uses the client-provided runId as the row id (URL persistence)", async () => {
  const rows: Record<string, unknown>[] = [];
  await saveAgentRun(
    { ...input(), runId: "INV-2042-fixed-instance" },
    capturingDb(rows),
  );
  assert.equal(rows[0]!["id"], "INV-2042-fixed-instance");
});

test("saveAgentRun is best-effort, a failing insert never throws", async () => {
  const exploding = {
    insert: (_table: unknown) => ({
      values: (_row: Record<string, unknown>) => ({
        onConflictDoUpdate: (_c: unknown) => {
          throw new Error("db down");
        },
      }),
    }),
  };
  // Must resolve, not reject, an audit-write failure can't break a live run.
  await assert.doesNotReject(() => saveAgentRun(input(), exploding));
});

test("toHistoryItem renames tier→outcome and ISO-stamps the date", () => {
  const item = toHistoryItem({
    id: "INV-1-abc",
    invoiceNumber: "INV-1",
    verdict: "duplicate",
    tier: "blocked",
    durationMs: 42,
    createdAt: new Date("2026-06-26T10:00:00Z"),
  });
  assert.deepEqual(item, {
    id: "INV-1-abc",
    invoiceNumber: "INV-1",
    verdict: "duplicate",
    outcome: "blocked",
    durationMs: 42,
    createdAt: "2026-06-26T10:00:00.000Z",
  });
});

test("parseStoredTrace returns the events for a valid blob", () => {
  const parsed = parseStoredTrace(sampleTrace);
  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.label, "Pipeline started");
});

test("parseStoredTrace returns null for a drifted / garbage blob", () => {
  assert.equal(parseStoredTrace([{ not: "a trace event" }]), null);
  assert.equal(parseStoredTrace("nonsense"), null);
  assert.equal(parseStoredTrace(null), null);
});
