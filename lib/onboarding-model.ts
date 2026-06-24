import type Anthropic from "@anthropic-ai/sdk";

import { anthropic } from "@/lib/anthropic";
import { OnboardingProposal } from "@/lib/approval-workflow";
import {
  ONBOARDING_SYSTEM_PROMPT,
  onboardingPrompt,
  parseProposal,
  type ProposalModel,
} from "@/lib/onboarding";
import { toModelJsonSchema, type OrgChart } from "@/lib/schema";

/**
 * The real onboarding model — a structured-output Anthropic call that produces an
 * `OnboardingProposal`. Same discipline as `lib/extract.ts`: hand the model a
 * JSON schema derived from the Zod object (single source of truth), then
 * `OnboardingProposal.parse` the result. This is "structured generation", not a
 * tool-using agent — the model emits the fuzzy decisions; deterministic code
 * (lib/onboarding.ts) assembles them into the validated workflow.
 *
 * Sonnet, not Haiku: the title→seniority judgement (which title is genuinely "more
 * senior", who fits "department head") is the kind of reasoning worth the better
 * model, and onboarding runs rarely (once per client), so latency/cost don't matter
 * the way they do on the per-invoice path.
 */

const ONBOARDING_MODEL = "claude-sonnet-4-6";

const PROPOSAL_JSON_SCHEMA = toModelJsonSchema(OnboardingProposal);

/**
 * The production `ProposalModel`: a structured-output call to Anthropic.
 *
 * @public — the onboarding flow / canvas calls this to derive a workflow from a
 * real org. (Injected as `ProposalModel` into `deriveWorkflow`.)
 */
export const anthropicProposalModel: ProposalModel = {
  async propose(org: OrgChart) {
    const message = await anthropic().messages.create({
      model: ONBOARDING_MODEL,
      max_tokens: 2048,
      system: ONBOARDING_SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: PROPOSAL_JSON_SCHEMA },
      },
      messages: [{ role: "user", content: onboardingPrompt(org) }],
    });

    if (message.stop_reason === "refusal") {
      throw new Error("Onboarding model refused the request.");
    }
    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return parseProposal(JSON.parse(raw));
  },
};
