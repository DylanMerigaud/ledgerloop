import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { env } from "@/lib/env";
import { log } from "@/lib/logger";

/**
 * Per-IP rate limiting via Upstash, for the public "Run pipeline" endpoint.
 * Configured for 8 runs per 10 minutes — enough to explore every seeded scenario
 * (clean / price / quantity / duplicate, plus an approve/reject) without leaving
 * the door open for a bot to drain the Anthropic budget.
 *
 * Design choice (mirrors the sibling ai-invoice-parser repo): if the Upstash env
 * vars are absent (e.g. local dev without a Redis instance), we FAIL OPEN — the
 * limiter is disabled and a one-time warning is logged. The app stays fully
 * functional; only the abuse guard is off. In production on Vercel you set the
 * two env vars and the guard engages.
 */

const WINDOW = "10 m" as const;
const LIMIT = 8;

export type RateVerdict =
  | { ok: true; remaining: number | null }
  | { ok: false; limit: number; reset: number; retryAfterSeconds: number };

let limiter: Ratelimit | null = null;
let initialized = false;

function getLimiter(): Ratelimit | null {
  if (initialized) return limiter;
  initialized = true;

  // Accept either naming convention so it works however you provision Redis:
  //   • Upstash directly  → UPSTASH_REDIS_REST_URL / _TOKEN
  //   • Vercel Marketplace → KV_REST_API_URL / _TOKEN (Vercel's Upstash add-on,
  //     which keeps the legacy "KV" prefix)
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;

  if (!url || !token) {
    log.warn(
      "[ratelimit] No Redis credentials found " +
        "(UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN) — " +
        "rate limiting is DISABLED (failing open).",
    );
    limiter = null;
    return limiter;
  }

  limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(LIMIT, WINDOW),
    prefix: "ledgerloop",
    analytics: false,
  });
  return limiter;
}

/** Check (and consume) one unit of the rate budget for the given IP. */
export async function checkRateLimit(ip: string): Promise<RateVerdict> {
  const rl = getLimiter();
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
    // If Redis itself errors, don't take the whole endpoint down — fail open but
    // log it so the operator notices.
    log.error("[ratelimit] Upstash error, failing open:", { err });
    return { ok: true, remaining: null };
  }
}

/** Best-effort client IP extraction from proxy headers (Vercel-friendly). */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? "anonymous";
}
