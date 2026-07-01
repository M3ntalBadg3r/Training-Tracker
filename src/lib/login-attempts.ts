/**
 * Per-account login lockout with escalating (exponential-style) backoff.
 *
 * The per-IP rate limiter (lib/rate-limit.ts) is the first line of defence, but
 * it does nothing against a distributed / credential-stuffing attack that spreads
 * guesses for one account across many IPs. This module adds a second line keyed
 * on the *account*: consecutive failed logins (bad password or bad MFA code) are
 * counted on the user row, and once they cross a threshold the account is locked
 * for a window that grows with each further failure. A successful login clears
 * the counter.
 *
 * DoS trade-off: because the lock is keyed on the account, an attacker who knows
 * a username can deliberately trip the lock to deny that user service. We keep
 * this tolerable by (a) leaving the per-IP limiter as the primary gate, (b)
 * capping the lock window (LOCK_LADDER_MS max), (c) auto-expiring locks, and (d)
 * returning the same generic message regardless of whether the account exists or
 * is locked, so the mechanism can't be used to enumerate accounts.
 */

import prisma from "@/lib/prisma";

/** Consecutive failures before the first lock kicks in. */
export const LOCKOUT_THRESHOLD = 5;

/**
 * Lock durations applied once the threshold is crossed, indexed by how many
 * failures past the threshold we are (0 = the threshold-th failure). Escalates
 * and then caps at the last entry.
 */
export const LOCK_LADDER_MS = [
  1 * 60_000, // 1 minute
  2 * 60_000, // 2 minutes
  5 * 60_000, // 5 minutes
  15 * 60_000, // 15 minutes
  30 * 60_000, // 30 minutes (cap)
];

export interface LockState {
  locked: boolean;
  /** Milliseconds until the lock expires (0 when not locked). */
  retryAfterMs: number;
}

/** Whether the given user is currently locked out, and for how much longer. */
export function isLockedOut(user: { lockedUntil: Date | null }): LockState {
  if (!user.lockedUntil) return { locked: false, retryAfterMs: 0 };
  const remaining = user.lockedUntil.getTime() - Date.now();
  if (remaining <= 0) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: remaining };
}

/**
 * Record a failed authentication attempt for a user. Increments the consecutive
 * failure counter and, once it reaches LOCKOUT_THRESHOLD, sets a lock whose
 * length escalates along LOCK_LADDER_MS.
 */
export async function registerFailure(userId: number): Promise<void> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true },
  });

  const attempts = updated.failedLoginAttempts;
  if (attempts < LOCKOUT_THRESHOLD) return;

  const ladderIndex = Math.min(
    attempts - LOCKOUT_THRESHOLD,
    LOCK_LADDER_MS.length - 1
  );
  const lockedUntil = new Date(Date.now() + LOCK_LADDER_MS[ladderIndex]);
  await prisma.user.update({
    where: { id: userId },
    data: { lockedUntil },
  });
}

/**
 * Clear the failure counter and any lock after a successful authentication.
 * Skips the write when there is nothing to clear.
 */
export async function registerSuccess(user: {
  id: number;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}): Promise<void> {
  if (user.failedLoginAttempts === 0 && !user.lockedUntil) return;
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });
}
