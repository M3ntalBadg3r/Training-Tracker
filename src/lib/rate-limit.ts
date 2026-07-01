/**
 * Persistent, shared sliding-window rate limiter.
 *
 * Counters live in the `rate_limit_buckets` table (see prisma/schema.prisma) so
 * limits survive process restarts and are shared across instances — the previous
 * implementation was an in-memory Map that reset on every restart and only
 * worked for a single process. Each limiter key (e.g. "login:<ip>") maps to one
 * row holding the current window's count and its expiry.
 */

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

export interface RateLimitResult {
  /** Whether this request is allowed under the limit. */
  allowed: boolean;
  /** Milliseconds until the current window resets (0 when allowed). */
  retryAfterMs: number;
}

// Opportunistic cleanup of expired rows, throttled so we don't issue a delete on
// every call. Fire-and-forget; failures are harmless (rows are ignored once
// expired anyway).
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = 0;

function maybeCleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  prisma.rateLimitBucket
    .deleteMany({ where: { resetAt: { lt: new Date(now) } } })
    .catch(() => {});
}

/**
 * Check whether a request is allowed under the rate limit, atomically recording
 * the attempt. Uses a single Postgres upsert so concurrent requests can't race
 * past the limit.
 *
 * @param key - Unique identifier (e.g. "login:<ip>", "apikey-fail:<ip>")
 * @param maxAttempts - Maximum attempts allowed per window
 * @param windowMs - Window length in milliseconds
 *
 * On a database error the limiter fails open (allows the request): the calling
 * handlers all need the database themselves, so an attacker can't make progress
 * during an outage anyway, and failing open avoids locking every user out over a
 * transient blip.
 */
export async function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  maybeCleanup(now);

  const nowDate = new Date(now);
  const resetDate = new Date(now + windowMs);

  try {
    // Insert a fresh bucket, or on conflict either reset it (window elapsed) or
    // increment it. RETURNING gives us the post-write count + reset time.
    const rows = await prisma.$queryRaw<Array<{ count: number; reset_at: Date }>>(
      Prisma.sql`
        INSERT INTO "rate_limit_buckets" ("key", "count", "reset_at")
        VALUES (${key}, 1, ${resetDate})
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE
            WHEN "rate_limit_buckets"."reset_at" <= ${nowDate} THEN 1
            ELSE "rate_limit_buckets"."count" + 1
          END,
          "reset_at" = CASE
            WHEN "rate_limit_buckets"."reset_at" <= ${nowDate} THEN ${resetDate}
            ELSE "rate_limit_buckets"."reset_at"
          END
        RETURNING "count", "reset_at"
      `
    );

    const row = rows[0];
    if (!row) return { allowed: true, retryAfterMs: 0 };

    const count = Number(row.count);
    if (count <= maxAttempts) {
      return { allowed: true, retryAfterMs: 0 };
    }
    const retryAfterMs = Math.max(0, row.reset_at.getTime() - now);
    return { allowed: false, retryAfterMs };
  } catch (err) {
    console.error("Rate limiter unavailable, failing open:", err);
    return { allowed: true, retryAfterMs: 0 };
  }
}

/**
 * Extract client IP from a request.
 *
 * `X-Forwarded-For` is only trustworthy when the application sits behind a
 * reverse proxy that overwrites it. Naively trusting the first entry lets
 * any internet-reachable client spoof a unique IP and bypass per-IP rate
 * limits. To be conservative we walk the XFF list from the right (closest
 * to the server) and return the first hop that is NOT in TRUSTED_PROXIES.
 *
 * Configure TRUSTED_PROXIES in .env as a comma-separated list of trusted
 * proxy IPs (e.g. "127.0.0.1,::1,10.0.0.5"). Leaving it at the default
 * loopback set is appropriate for the typical single-host deployment fronted
 * by nginx/Apache.
 */
export function getClientIp(request: Request): string {
  const trusted = (process.env.TRUSTED_PROXIES ?? "127.0.0.1,::1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .reverse();
    for (const ip of hops) {
      if (!trusted.includes(ip)) return ip;
    }
  }
  return "unknown";
}
