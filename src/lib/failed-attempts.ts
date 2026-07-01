/**
 * Failed-attempt audit log + unblock helpers.
 *
 * Records rejected authentication attempts (login and public API) so a SuperAdmin
 * can see who is failing to log in / hammering the API, and clear a block. Only
 * genuine credential attempts are logged here — requests rejected purely by the
 * rate limiter are not (they would amplify rows under attack and are instead
 * surfaced as "currently blocked IPs" derived from RateLimitBucket).
 *
 * All recorders are fire-and-forget: they never block or throw into the response.
 */

import prisma from "@/lib/prisma";
import { hashApiKey, maskPresentedKey } from "@/lib/api-key";

export type LoginFailureReason = "bad_password" | "bad_mfa" | "unknown_user";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Opportunistic pruning of old rows, throttled so we don't issue a delete on
// every attempt.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let lastPrune = 0;

function maybePrune(): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  prisma.failedAttempt
    .deleteMany({ where: { createdAt: { lt: new Date(now - RETENTION_MS) } } })
    .catch(() => {});
}

/** Record a rejected login attempt (fire-and-forget). */
export function recordLoginFailure(params: {
  username: string;
  ip: string;
  reason: LoginFailureReason;
}): void {
  maybePrune();
  prisma.failedAttempt
    .create({
      data: {
        kind: "login",
        identifier: params.username.slice(0, 200),
        ip: params.ip,
        reason: params.reason,
      },
    })
    .catch(() => {});
}

/**
 * Record a rejected public-API request (fire-and-forget). The presented key is
 * masked before storage; if it hashes to a known key we record that key's name
 * and a more specific reason (disabled/revoked/expired).
 */
export async function recordApiFailure(params: {
  presentedKey: string;
  ip: string;
}): Promise<void> {
  maybePrune();
  const { presentedKey, ip } = params;

  let reason = "invalid_key";
  let keyName: string | null = null;
  try {
    const record = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(presentedKey) },
      select: { name: true, enabled: true, revokedAt: true, expiresAt: true },
    });
    if (record) {
      keyName = record.name;
      if (record.revokedAt) reason = "revoked_key";
      else if (!record.enabled) reason = "disabled_key";
      else if (record.expiresAt && record.expiresAt <= new Date()) reason = "expired_key";
    }
  } catch {
    /* fall back to invalid_key with no name */
  }

  await prisma.failedAttempt
    .create({
      data: {
        kind: "api",
        identifier: maskPresentedKey(presentedKey),
        ip,
        reason,
        keyName,
      },
    })
    .catch(() => {});
}

export interface FailedAttemptRow {
  id: number;
  kind: string;
  identifier: string;
  ip: string;
  reason: string;
  keyName: string | null;
  createdAt: Date;
}

/** Most recent failed attempts of a given kind (within the retention window). */
export async function listFailedAttempts(
  kind: "login" | "api",
  limit = 200
): Promise<FailedAttemptRow[]> {
  return prisma.failedAttempt.findMany({
    where: { kind, createdAt: { gte: new Date(Date.now() - RETENTION_MS) } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Clear a per-account lockout so the user can log in again immediately. Matches
 * on the lowercased username (usernames are stored lowercase).
 */
export async function unblockUsername(username: string): Promise<void> {
  await prisma.user.updateMany({
    where: { username: username.toLowerCase() },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });
}

/**
 * Clear every per-IP rate-limit bucket for an IP. All per-IP limiter keys end in
 * `:<ip>` (login:<ip>, apikey-fail:<ip>, setup:<ip>, mfa:<sub>:<ip>, …), so this
 * lifts the throttle across all auth surfaces for that address.
 */
export async function unblockIp(ip: string): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({ where: { key: { endsWith: `:${ip}` } } });
}
