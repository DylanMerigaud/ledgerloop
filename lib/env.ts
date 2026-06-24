import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Typed, validated environment — the single place env vars are read.
 *
 * Everywhere else imports `env` instead of touching `process.env` (enforced by
 * ESLint), so a missing or malformed var is a clear boot-time error with a name,
 * not an `undefined` surfacing three layers deep. Optionality here mirrors the
 * app's real degradation: the BambooHR creds and the Redis/KV pair are OPTIONAL —
 * without them the HRIS adapter replays the recorded fixture and the rate-limiter
 * fails open. Only what the app genuinely can't run without is required.
 */
export const env = createEnv({
  server: {
    /** Node environment — drives dev-only logging. */
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    /** Postgres connection (seeded invoice queue). Required — there's no app without it. */
    DATABASE_URL: z.string().min(1),
    /** Direct (non-pooled) Postgres URL, used by migrations/tooling. Optional. */
    DIRECT_DATABASE_URL: z.string().min(1).optional(),
    /** Anthropic key for the vision extraction + agents. Optional: absent → those
     *  paths report a clear "missing key" failure instead of crashing at import. */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** BambooHR API key. Optional — absent → the HRIS adapter replays the fixture. */
    BAMBOO_HR_API_KEY: z.string().min(1).optional(),
    /** BambooHR company subdomain (the `neige` in neige.bamboohr.com). Optional. */
    BAMBOO_HR_SUBDOMAIN: z.string().min(1).optional(),
    /** Upstash Redis REST creds for rate-limiting. Optional — absent → fails open. */
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
    /** Vercel KV aliases for the same Redis (either pair works). Optional. */
    KV_REST_API_URL: z.string().url().optional(),
    KV_REST_API_TOKEN: z.string().min(1).optional(),
  },
  client: {},
  /**
   * Next.js edge runtimes can't destructure `process.env`, so each value is
   * threaded explicitly. (Server-only here; no NEXT_PUBLIC_* needed.)
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    BAMBOO_HR_API_KEY: process.env.BAMBOO_HR_API_KEY,
    BAMBOO_HR_SUBDOMAIN: process.env.BAMBOO_HR_SUBDOMAIN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  },
  /** `SKIP_ENV_VALIDATION=1` skips validation — useful for Docker/CI builds. */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /** Treat empty strings as undefined, so `VAR=''` doesn't pass a required check. */
  emptyStringAsUndefined: true,
});
