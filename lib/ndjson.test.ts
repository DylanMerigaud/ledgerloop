import { test } from "node:test";
import assert from "node:assert/strict";
import { NdjsonBuffer, ndjsonLine } from "./ndjson";

/**
 * Tests for the NDJSON framing — the contract shared by the run route (writer)
 * and the client hook (reader). The property that matters for streaming: a line
 * must reassemble correctly no matter where the network splits the byte chunks.
 */

test("emits whole lines, holds the trailing partial", () => {
  const buf = new NdjsonBuffer();
  assert.deepEqual(buf.push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(buf.push('{"c":3}'), []); // no newline yet
  assert.equal(buf.rest(), '{"c":3}');
  assert.deepEqual(buf.push("\n"), ['{"c":3}']);
});

test("reassembles a line split across many chunks", () => {
  const buf = new NdjsonBuffer();
  const line = ndjsonLine({ hello: "world", n: 42 });
  // Feed it one character at a time — the worst-case fragmentation.
  const out: string[] = [];
  for (const ch of line) out.push(...buf.push(ch));
  assert.deepEqual(out, [JSON.stringify({ hello: "world", n: 42 })]);
});

test("a chunk carrying multiple lines plus a partial", () => {
  const buf = new NdjsonBuffer();
  const lines = buf.push("one\ntwo\nthr");
  assert.deepEqual(lines, ["one", "two"]);
  assert.deepEqual(buf.push("ee\n"), ["three"]);
});

test("blank lines are skipped", () => {
  const buf = new NdjsonBuffer();
  assert.deepEqual(buf.push('\n\n{"x":1}\n\n'), ['{"x":1}']);
});

test("round-trips a sequence of values through serialize → parse", () => {
  const values = [
    { seq: 0, kind: "run" },
    { seq: 1, kind: "step" },
    { done: true },
  ];
  const wire = values.map(ndjsonLine).join("");
  const buf = new NdjsonBuffer();
  const parsed = buf.push(wire).map((l) => JSON.parse(l));
  assert.deepEqual(parsed, values);
});
