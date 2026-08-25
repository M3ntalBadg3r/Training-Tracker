import prisma from "@/lib/prisma";

/**
 * Account-suspension lookup for the auth guards.
 *
 * A disabled user must lose access to a session they are *already* holding, not
 * just be refused at the next login. That can't be done in `proxy.ts`: the edge
 * proxy does no DB access at all, and it slides the auth token forward
 * preserving every claim — so a token minted before the disable stays valid for
 * the whole idle window (default 30 min) and no claim can revoke it. The check
 * therefore lives at the Node-runtime chokepoints every request passes through:
 * `requireAuth`/`requireSuperAdmin` in lib/auth.ts, plus /api/auth/me and
 * /api/auth/ping (which use `getAuthFromRequest` directly).
 *
 * That puts a DB read on the hot path, so it is cached. Disabled accounts are
 * rare, so one small "which ids are disabled" query serves every request in the
 * window rather than a per-user lookup.
 */

/**
 * How long a cached snapshot is trusted. Also the worst-case delay before a
 * disable takes effect in a *different* module instance (route handlers and
 * server components are bundled separately — see CLAUDE.md) or another app
 * instance; the route that flips the flag invalidates its own cache
 * immediately.
 */
const TTL_MS = 15_000;

let cache: { ids: Set<number>; at: number } | null = null;
let inflight: Promise<Set<number>> | null = null;

async function loadDisabledIds(): Promise<Set<number>> {
  const rows = await prisma.user.findMany({
    where: { disabledAt: { not: null } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

async function getDisabledIds(): Promise<Set<number>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.ids;
  // Collapse a burst of concurrent requests onto one query.
  if (!inflight) {
    inflight = loadDisabledIds()
      .then((ids) => {
        cache = { ids, at: Date.now() };
        return ids;
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
    const ids = await getDisabledIds();
    return ids.has(userId);
  } catch {
    return false;
  }
}

/** Drop the cached snapshot so the next check re-reads. Called after a toggle. */
export function invalidateUserStatusCache(): void {
  cache = null;
}
