import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApprovalWorkflow as TWorkflow } from "@/lib/approval-workflow";
import {
  WorkflowSuggestions,
  parseSuggestions,
  suggestPrompt,
} from "@/lib/workflow-suggest";

/**
 * The suggest model's OUTPUT is open-ended (tested for relevance by hand / live),
 * but the deterministic edges around it must hold: the schema must stay free of the
 * `maxItems` constraint that structured-output rejects (a 400 that silently turned
 * every call into "no suggestions"), and the cap to three is enforced in code.
 */

test("the schema has no maxItems (structured-output rejects it)", () => {
  // A 4-element list must still PARSE — the cap is applied after, not in the schema.
  const parsed = WorkflowSuggestions.parse({
    suggestions: ["a", "b", "c", "d"],
  });
  assert.equal(parsed.suggestions.length, 4);
});

test("parseSuggestions caps the list at three", () => {
  const out = parseSuggestions({ suggestions: ["a", "b", "c", "d", "e"] });
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("parseSuggestions passes through an empty list", () => {
  assert.deepEqual(parseSuggestions({ suggestions: [] }), []);
});

test("parseSuggestions rejects a malformed payload", () => {
  assert.throws(() => parseSuggestions({ suggestions: "nope" }));
  assert.throws(() => parseSuggestions({}));
});

test("suggestPrompt lists each step with its condition", () => {
  const wf: TWorkflow = {
    name: "t",
    roots: ["m"],
    steps: [
      {
        id: "m",
        kind: "approval",
        label: "Manager review",
        when: { kind: "always" },
        approverTitle: "Manager",
        approverName: "Riley",
        next: ["post"],
      },
      {
        id: "post",
        kind: "integration",
        label: "Post to NetSuite",
        when: { kind: "leaf", field: "amount", op: ">", value: 1000 },
        integration: "netsuite",
        next: [],
      },
    ],
  };
  const prompt = suggestPrompt(wf);
  assert.match(prompt, /Manager review/);
  assert.match(prompt, /netsuite/);
  // the condition is described, so the model can avoid redundant suggestions
  assert.match(prompt, /amount/);
});
