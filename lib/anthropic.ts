import Anthropic from "@anthropic-ai/sdk";

import { env } from "@/lib/env";

/**
 * One shared, lazily-created Anthropic client.
 *
 * Three call sites need a client (invoice extraction, the onboarding model, the
 * workflow-edit model) and all had the same `let cached; if (!key) throw` dance.
 * This is that, once. The key is OPTIONAL in `env` (so the app boots without it
 * and the no-key paths degrade), so the check lives here and throws a clear error
 * only when a model call is actually attempted without a key.
 */
export class MissingAnthropicKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "MissingAnthropicKeyError";
  }
}

let cached: Anthropic | null = null;

export const anthropic = (): Anthropic => {
  if (!cached) {
    if (!env.ANTHROPIC_API_KEY) throw new MissingAnthropicKeyError();
    cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return cached;
};
