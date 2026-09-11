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
import { normaliseIp, resolveTrustedProxies, type TrustedProxies } from "@/lib/client-ip";

export interface RateLimitResult {
  /** Whether this request is allowed under the limit. */
  allowed: boolean;
  /** Milliseconds until the current window resets (0 when allowed). */
  retryAfterMs: number;
}

// Per-IP login limit. Exported so the "currently blocked IPs" admin query
// (lib/failed-attempts.ts) uses the same threshold the login route enforces.
export const LOGIN_IP_MAX_ATTEMPTS = 10;
export const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;

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

// The list is re-resolved only when the environment value itself changes, so
// the parse (and its validation) no longer runs on every single request. Keyed
// on the raw string rather than resolved once, so a process that rewrites the
// variable is still honoured.
let trustedCache: { raw: string | undefined; parsed: TrustedProxies } | null = null;
let warnedInvalidTrusted = false;

function trustedProxies(): TrustedProxies {
  const raw = process.env.TRUSTED_PROXIES;
  if (trustedCache && trustedCache.raw === raw) return trustedCache.parsed;

  // Shared with the boot check in `src/instrumentation.ts`, so the addresses
  // it reports are by construction the addresses matched here.
  const parsed = resolveTrustedProxies(raw);

  if (parsed.invalid.length && !warnedInvalidTrusted) {
    warnedInvalidTrusted = true;
    console.warn(
      `TRUSTED_PROXIES contains ${parsed.invalid.length} entry/entries that are not IP addresses and are being ` +
        `ignored: ${parsed.invalid.join(", ")}. Only plain IPv4/IPv6 literals are matched — CIDR ranges and ` +
        `hostnames are not supported. If one of those is your reverse proxy, per-IP limits are counting every ` +
        `client behind it as one.`
    );
  }

  trustedCache = { raw, parsed };
  return parsed;
}

/** Warned once per process, not once per request. */
let warnedUnknownClient = false;

/** Bucket used when no client address can be established. @see getClientIp */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * Extract client IP from a request.
 *
 * `X-Forwarded-For` is only trustworthy when the application sits behind a
 * reverse proxy that overwrites it. Naively trusting the first entry lets
 * any internet-reachable client spoof a unique IP and bypass per-IP rate
 * limits. To be conservative we walk the XFF list from the right (closest
 * to the server) and return the first hop that is a valid IP literal and is
 * NOT in TRUSTED_PROXIES.
 *
 * A hop that is not an IP literal **stops the walk** — it does not become a
 * bucket key (this value is a database key, and junk of unbounded shape has no
 * business being one) and the walk does not step past it either. Stepping past
 * is worse than either alternative: Squid with `forwarded_for off` appends the
 * literal `unknown`, and under such a proxy walking left would land on the
 * first client-supplied entry, letting a caller both pick a fresh bucket per
 * request and nominate somebody else's address to be throttled. Once a hop is
 * unreadable, nothing further left is attributable, so the walk fails closed
 * to `UNKNOWN_CLIENT_IP`.
 *
 * An **empty** hop is not treated as unreadable — empties are dropped before
 * the walk. The distinction is deliberate: a non-empty token that is not an
 * address is a positive claim by a hop that it would not or could not name the
 * client (Squid's literal `unknown`), whereas an empty token between two
 * commas is a formatting artifact and carries no claim at all. Stopping on it
 * would also make `"1.2.3.4,127.0.0.1,"` — a proxy that emits a trailing comma
 * — resolve to `UNKNOWN_CLIENT_IP`, silently collapsing every client on that
 * deployment into one bucket, which is the failure this code exists to avoid.
 *
 * Configure TRUSTED_PROXIES in .env as a comma-separated list of trusted
 * proxy IPs (e.g. "127.0.0.1,::1,10.0.0.5"). Leaving it at the default
 * loopback set is appropriate for the typical single-host deployment fronted
 * by nginx/Apache on the same machine.
 *
 * Two ways this degrades into one shared bucket, and only one of them is
 * detectable:
 *
 *  - **No XFF header at all** (nothing in front of the app, or a proxy that
 *    does not set the header). Every caller then shares the single
 *    `UNKNOWN_CLIENT_IP` bucket, so one client's failed logins throttle
 *    everybody. That is visible from here, and is warned about once per
 *    process the first time it happens.
 *  - **A proxy whose own address is missing from TRUSTED_PROXIES.** Its
 *    address is then returned for every client, collapsing them into one
 *    bucket just as badly. This is **not** detectable from inside the
 *    process: with a single proxy that sets XFF, the rightmost hop
 *    legitimately *is* the client, so a correct deployment and a
 *    misconfigured one produce byte-identical observations. There is
 *    deliberately no check for it — claiming one would be worse than having
 *    none. The whole mitigation is the note `src/instrumentation.ts` prints on
 *    **every** production boot, naming the addresses actually being trusted so
 *    an operator can compare them against the real topology. That note is
 *    unconditional for this reason: printing it only when TRUSTED_PROXIES was
 *    unset would have skipped the one case anybody checks.
 */
export function getClientIp(request: Request): string {
  const { addresses } = trustedProxies();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0) // A formatting artifact, not a claim.
      .reverse();
    for (const hop of hops) {
      const ip = normaliseIp(hop);
      if (!ip) break; // Unreadable hop: nothing further left is attributable.
      if (!addresses.has(ip)) return ip;
    }
  }

  if (!warnedUnknownClient) {
    warnedUnknownClient = true;
    console.warn(
      "No client address could be attributed from X-Forwarded-For, so per-IP limits (failed logins, invalid API " +
        "keys) are counting every caller as one client — one person's failures can throttle everyone. Either the " +
        "header is absent, or every entry in it is a trusted proxy, or an entry was not a readable IP address " +
        "(some proxies append the literal 'unknown'), which stops the walk on purpose rather than trusting what " +
        "lies beyond it. If this app is behind a reverse proxy, configure that proxy to append the real client " +
        "address. If it is directly exposed, per-IP rate limiting cannot work at all and the per-account lockout " +
        "is the only brute-force defence left."
    );
  }
  return UNKNOWN_CLIENT_IP;
}
