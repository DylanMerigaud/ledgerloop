/**
 * One place to name the model the investigator agent runs on.
 *
 * Mastra has a built-in model router: a string like "anthropic/claude-haiku-4-5"
 * resolves to the provider + model with no SDK wiring, reading ANTHROPIC_API_KEY
 * from the environment. We use a small, fast Claude (Haiku) on purpose — the one
 * agent call (only on an exception) finishes in a couple of seconds, so the live
 * trace streams briskly and the streaming route stays well inside its timeout.
 *
 * Swapping providers is a one-line change here (e.g. "openai/gpt-4o-mini"), since
 * the agent imports PIPELINE_MODEL rather than hard-coding a string.
 */
export const PIPELINE_MODEL = "anthropic/claude-haiku-4-5" as const;
