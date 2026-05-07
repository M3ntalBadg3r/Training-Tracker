/**
 * Simple in-memory sliding-window rate limiter.
 * Suitable for single-instance deployments.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Periodic cleanup to prevent unbounded memory growth
const CLEANUP_INTERVAL = 60_000; // 1 minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) {
      store.delete(key);
    }
  }
}, CLEANUP_INTERVAL).unref();

/**
 * Check if a request should be allowed under the rate limit.
 * @param key - Unique identifier (e.g., IP address, "login:<ip>")
 * @param maxAttempts - Maximum number of attempts allowed in the window
 * @param windowMs - Time window in milliseconds
 * @returns true if allowed, false if rate limited
 */
export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxAttempts) {
    return false;
  }

  entry.count++;
  return true;
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
