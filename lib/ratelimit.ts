import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { env } from "@/lib/env";
import { log } from "@/lib/logger";

/**
 * Per-IP rate limiting via Upstash, for the public demo endpoints.
 *
 * TWO buckets, because the calls cost wildly different amounts. The "sonnet"
 * bucket guards the expensive Sonnet calls (invoice vision, onboarding derivation,
 * workflow edit) at 15 per 10 minutes, enough to explore every seeded scenario in a
 * live demo without letting a bot drain the Anthropic budget. The "cheap" bucket
 * guards the resume path (an approve/reject re-run that skips extraction and only
 * spends a Haiku investigator call) at a very high 100 per 10 minutes, so a human
 * clicking Approve never hits it, but a bot spamming resumes still gets cut.
 * Read-only calls (history / replay) aren't rate-limited at all (no model tokens).
 *
 * Design choice (mirrors the sibling ai-invoice-parser repo): if the Upstash env
 * vars are absent (e.g. local dev without a Redis instance), we FAIL OPEN, the
 * limiter is disabled and a one-time warning is logged. The app stays fully
 * functional; only the abuse guard is off. In production on Vercel you set the
 * two env vars and the guard engages.
 */

const WINDOW = "10 m" as const;

/** The rate-limit buckets, by cost tier. Each has its own per-IP counter. */
export type RateTier = "sonnet" | "cheap";
const LIMITS: Record<RateTier, number> = {
  sonnet: 15, // vision / onboarding / edit: the real Anthropic spend
  cheap: 100, // resume (approve/reject), Haiku only; high enough to never hit by hand
};

export type RateVerdict =
  | { ok: true; remaining: number | null }
  | { ok: false; limit: number; reset: number; retryAfterSeconds: number };

const limiters = new Map<RateTier, Ratelimit | null>();
let redis: Redis | null = null;
let redisResolved = false;

const getRedis = (): Redis | null => {
  if (redisResolved) return redis;
  redisResolved = true;

  // Accept either naming convention so it works however you provision Redis:
  //   • Upstash directly  → UPSTASH_REDIS_REST_URL / _TOKEN
  //   • Vercel Marketplace → KV_REST_API_URL / _TOKEN (Vercel's Upstash add-on,
  //     which keeps the legacy "KV" prefix)
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;

  if (!url || !token) {
    log.warn(
      "[ratelimit] No Redis credentials found " +
        "(UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN), " +
        "rate limiting is DISABLED (failing open).",
    );
    redis = null;
    return redis;
  }
  redis = new Redis({ url, token });
  return redis;
};

/** One limiter per tier, each with its own Redis key prefix so counters don't share. */
const getLimiter = (tier: RateTier): Ratelimit | null => {
  if (limiters.has(tier)) return limiters.get(tier) ?? null;
  const r = getRedis();
  const limiter = r
    ? new Ratelimit({
        redis: r,
        limiter: Ratelimit.slidingWindow(LIMITS[tier], WINDOW),
        prefix: `ledgerloop:${tier}`,
        analytics: false,
      })
    : null;
  limiters.set(tier, limiter);
  return limiter;
};

/** Check (and consume) one unit of the given tier's rate budget for the IP. */
export const checkRateLimit = async (
  ip: string,
  tier: RateTier,
): Promise<RateVerdict> => {
  const rl = getLimiter(tier);
  if (!rl) {
    // Failing open: always allow.
    return { ok: true, remaining: null };
  }

  try {
    const { success, limit, reset, remaining } = await rl.limit(ip);
    if (success) {
      return { ok: true, remaining };
    }
    const retryAfterSeconds = Math.max(
      0,
      Math.ceil((reset - Date.now()) / 1000),
    );
    return { ok: false, limit, reset, retryAfterSeconds };
  } catch (err) {
    // If Redis itself errors, don't take the whole endpoint down, fail open but
    // log it so the operator notices.
    log.error("[ratelimit] Upstash error, failing open:", { err });
    return { ok: true, remaining: null };
  }
};

/** Best-effort client IP extraction from proxy headers (Vercel-friendly). */
export const clientIpFrom = (headers: Headers): string => {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? "anonymous";
};
