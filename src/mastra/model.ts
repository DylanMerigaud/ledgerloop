/**
 * One place to name the model the whole pipeline runs on.
 *
 * Mastra has a built-in model router: a string like "anthropic/claude-haiku-4-5"
 * resolves to the provider + model with no SDK wiring, reading ANTHROPIC_API_KEY
 * from the environment. We use a small, fast Claude (Haiku) on purpose — a full
 * four-agent run is then a few short calls that finish in seconds, so the live
 * trace streams briskly and the Edge route never times out.
 *
 * Swapping providers is a one-line change here (e.g. "openai/gpt-4o-mini"), since
 * every agent imports PIPELINE_MODEL rather than hard-coding a string.
 */
export const PIPELINE_MODEL = "anthropic/claude-haiku-4-5" as const;
