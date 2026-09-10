import prisma from "@/lib/prisma";

/**
 * Session-revocation lookups for the auth guards: account suspension
 * (`disabledAt`) and the session epoch (`sessionEpoch`).
 *
 * Both answer the same question — "is this token still good?" — and neither can
 * be answered in `proxy.ts`: the edge proxy does no DB access at all, and it
 * slides the auth token forward preserving every claim, so a token minted
 * before a disable (or before a password change) stays valid for the whole idle
 * window and no claim can revoke it. The checks therefore live at the
 * Node-runtime chokepoints every request passes through:
 * `requireAuth`/`requireSuperAdmin` in lib/auth.ts, plus /api/auth/me,
 * /api/auth/ping and /api/auth/change-password (which use `getAuthFromRequest`
 * directly).
 *
 * That puts a DB read on the hot path, so it is cached. Both conditions are
 * rare — most accounts are enabled and sit at epoch 0 — so one small query
 * returning only the *exceptional* rows serves every request in the window
 * rather than a per-user lookup.
 */

/**
 * How long a cached snapshot is trusted. Also the worst-case delay before a
 * disable takes effect in a *different* module instance (route handlers and
 * server components are bundled separately — see CLAUDE.md) or another app
 * instance; the route that flips the flag invalidates its own cache
 * immediately.
 */
const TTL_MS = 15_000;

interface StatusSnapshot {
  /** Ids of accounts that are currently suspended. */
  disabled: Set<number>;
  /**
   * Ids whose `sessionEpoch` is above the 0 default, mapped to that value.
   * Sparse on purpose: an account that has never had its sessions revoked is
   * absent, and absent is read as 0.
   */
  epochs: Map<number, number>;
}

let cache: { snapshot: StatusSnapshot; at: number } | null = null;
let inflight: Promise<StatusSnapshot> | null = null;

async function loadSnapshot(): Promise<StatusSnapshot> {
  const rows = await prisma.user.findMany({
    where: {
      OR: [{ disabledAt: { not: null } }, { sessionEpoch: { gt: 0 } }],
    },
    select: { id: true, disabledAt: true, sessionEpoch: true },
  });
  const disabled = new Set<number>();
  const epochs = new Map<number, number>();
  for (const row of rows) {
    if (row.disabledAt !== null) disabled.add(row.id);
    if (row.sessionEpoch > 0) epochs.set(row.id, row.sessionEpoch);
  }
  return { disabled, epochs };
}

async function getSnapshot(): Promise<StatusSnapshot> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.snapshot;
  // Collapse a burst of concurrent requests onto one query.
  if (!inflight) {
    inflight = loadSnapshot()
      .then((snapshot) => {
        cache = { snapshot, at: Date.now() };
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Is this account currently suspended?
 *
 * **Fails open** (reports `false`) if the lookup throws — the same convention as
 * lib/rate-limit.ts. Failing closed would sign every user in the instance out
 * on a transient DB blip, which is a far worse outcome than a disabled account
 * keeping its session for a few seconds longer.
 */
export async function isUserDisabled(userId: number): Promise<boolean> {
  try {
    const { disabled } = await getSnapshot();
    return disabled.has(userId);
  } catch {
    return false;
  }
}

/**
 * Has this token been revoked by a later password change or admin reset?
 *
 * `tokenEpoch` is the `sessionEpoch` claim the token carries — `undefined` for
 * a token minted before the claim existed, which is read as 0 and so matches
 * the column default. A token is stale once its epoch is behind the account's.
 *
 * **Fails open** for the same reason as `isUserDisabled` above.
 */
export async function isSessionEpochStale(
  userId: number,
  tokenEpoch: number | undefined
): Promise<boolean> {
  try {
    const { epochs } = await getSnapshot();
    const current = epochs.get(userId) ?? 0;
    return (tokenEpoch ?? 0) < current;
  } catch {
    return false;
  }
}

/**
 * Drop the cached snapshot so the next check re-reads. Called after a disable
 * toggle and after a session-epoch bump.
 */
export function invalidateUserStatusCache(): void {
  cache = null;
}

/**
 * The predicate for "a SuperAdmin who could actually administer this instance".
 *
 * Disabled accounts are excluded deliberately: a suspended SuperAdmin can't
 * administer anything, so counting one would let the last usable SuperAdmin be
 * removed and lock everyone out of admin. Kept here, next to the rest of the
 * account-usability reasoning, so the user-management guards and the backup
 * restore can't drift on what "usable" means.
 */
export const USABLE_SUPER_ADMIN_WHERE = {
  role: "SuperAdmin",
  disabledAt: null,
} as const;

/**
 * How many usable SuperAdmins the instance has, optionally ignoring one id
 * (the account being demoted, disabled or deleted).
 */
export async function countUsableSuperAdmins(
  excludeUserId?: number
): Promise<number> {
  return prisma.user.count({
    where:
      excludeUserId === undefined
        ? USABLE_SUPER_ADMIN_WHERE
        : { ...USABLE_SUPER_ADMIN_WHERE, id: { not: excludeUserId } },
  });
}
