/**
 * Single-use enforcement for cron request nonces — the replay half of the cron
 * HMAC (see `lib/cron-auth.ts` for what is signed and why).
 *
 * Nonces are stored in the existing `rate_limit_buckets` table rather than a
 * table of their own: it is already the project's short-TTL, cross-instance,
 * "transient and not backed up" key store, and its opportunistic pruning is the
 * behaviour a nonce store wants anyway. Keys are namespaced `cron-nonce:<hex>`.
 * The two admin queries that read that table (`admin/failed-attempts`) filter on
 * a `login:` / `apikey-fail:` prefix **and** `count >= limit`, and `unblockIp`
 * matches a `:<ip>` suffix, so a `count = 0` nonce row matches none of them.
 */

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  CRON_MAX_SKEW_SECONDS,
  verifyCronRequest,
  type CronRequestLike,
} from "@/lib/cron-auth";

const NONCE_KEY_PREFIX = "cron-nonce:";

/**
 * Retention must be at least the acceptance window: a nonce may be presented at
 * any point while its timestamp is still valid, so it has to stay remembered for
 * at least that long or a replay could land after the row was pruned. Doubled
 * for margin — these rows are tiny and self-pruning.
 */
const NONCE_TTL_MS = CRON_MAX_SKEW_SECONDS * 2 * 1000;

// Opportunistic pruning, mirroring lib/rate-limit.ts. Done here as well as there
// because an install whose only traffic is cron would otherwise never trigger
// that module's cleanup, and these rows would accumulate unbounded.
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
 * Record a nonce, returning true only the first time it is seen.
 *
 * The insert is `ON CONFLICT DO NOTHING`, so concurrency is decided by Postgres
 * rather than by a read-then-write race: exactly one caller gets the row.
 *
 * **Fails closed**, unlike the fail-open convention in `rate-limit.ts` and
 * `user-status.ts`. Those guard availability — failing closed there would sign
 * every user out over a transient blip. This guards authenticity, and the only
 * caller is cron, which retries on its next tick. There is also nothing to gain
 * from failing open: every endpoint behind this check needs the same database to
 * do its work, so it would fail moments later anyway.
 */
export async function consumeCronNonce(nonce: string): Promise<boolean> {
  const now = Date.now();
  maybeCleanup(now);

  const key = `${NONCE_KEY_PREFIX}${nonce}`;
  const expiresAt = new Date(now + NONCE_TTL_MS);

  try {
    const inserted = await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "rate_limit_buckets" ("key", "count", "reset_at")
      VALUES (${key}, 0, ${expiresAt})
      ON CONFLICT ("key") DO NOTHING
    `);
    return inserted === 1;
  } catch {
    return false;
  }
}

/**
 * Full cron authorisation for a route handler: authentic, current signature over
 * this method and path, **and** a nonce that has not been used before.
 *
 * This is the function route handlers must use. `verifyCronRequest` on its own
 * carries no replay protection and exists for `proxy.ts`, which cannot reach the
 * database — see the module comment in `lib/cron-auth.ts`.
 */
export async function authorizeCronRequest(
  request: CronRequestLike
): Promise<boolean> {
  const verdict = verifyCronRequest(request);
  if (!verdict.ok || !verdict.nonce) return false;
  return consumeCronNonce(verdict.nonce);
}
