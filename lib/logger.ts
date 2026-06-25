import { env } from "@/lib/env";

/**
 * The app logger — one shape for all logging, one place to wire Sentry/PostHog.
 *
 * App code uses `log.info("...", { meta })` instead of `console.*` (enforced by
 * ESLint). In development it prints to the console; in production it's the single
 * seam where an external sink would be added. Scripts/sanity/eval keep `console`
 * (they're terminal tools, exempted in the ESLint config).
 */
type LogLevel = "debug" | "info" | "warn" | "error";

type Meta = Record<string, unknown>;

const isDev = env.NODE_ENV !== "production";

const emit = (level: LogLevel, message: string, meta?: Meta): void => {
  if (!isDev) {
    // Production sink would go here (Sentry/PostHog). Kept intentionally silent
    // for now rather than noisy server logs; errors could be forwarded later.
    return;
  }
  const line = `${new Date().toISOString()} ${level.toUpperCase()}: ${message}`;
  const args = meta ? [line, meta] : [line];
  // The logger is the ONE sanctioned console user (the lint rule is off in this file).
  if (level === "error") console.error(...args);
  else if (level === "warn") console.warn(...args);
  else console.log(...args);
};

export const log = {
  debug: (message: string, meta?: Meta) => emit("debug", message, meta),
  info: (message: string, meta?: Meta) => emit("info", message, meta),
  warn: (message: string, meta?: Meta) => emit("warn", message, meta),
  error: (message: string, meta?: Meta) => emit("error", message, meta),
};
