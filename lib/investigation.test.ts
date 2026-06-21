import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./investigation";

/**
 * `classify` turns the agent's free-text recommendation into a label. It's a
 * heuristic (the agent is asked to lead with its verdict), so these pin the
 * behaviour that matters: a clear lead wins even if a later word in the paragraph
 * could trip a naive whole-text scan.
 */

test("a clear 'legitimate' lead → likely_legitimate", () => {
  assert.equal(
    classify(
      "LEGITIMATE. The surcharge was flagged in advance and is in line with the market.",
    ),
    "likely_legitimate",
  );
});

test("a clear 'overcharge / error' lead → likely_overcharge", () => {
  assert.equal(
    classify(
      "OVERCHARGE/ERROR. Prices were flat for 3 quarters; this is a billing slip to dispute.",
    ),
    "likely_overcharge",
  );
});

test("a legitimate verdict isn't flipped by a later 'correction' mention", () => {
  // Real failure seen live: the rationale ended with "...returned for correction"
  // which a whole-text scan could read as an error signal. The lead must win.
  assert.equal(
    classify(
      "RECOMMENDATION: LEGITIMATE. The vendor pre-notified the surcharge; if anything is off send it back for correction.",
    ),
    "likely_legitimate",
  );
});

test("genuinely ambiguous prose → unclear", () => {
  assert.equal(
    classify(
      "It's hard to say from the records — the quantity is short but there may be a backorder; needs follow-up.",
    ),
    "unclear",
  );
});

test("empty / contentless text → unclear", () => {
  assert.equal(classify(""), "unclear");
  assert.equal(classify("   "), "unclear");
});
