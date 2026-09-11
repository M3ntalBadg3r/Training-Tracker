import prisma from "@/lib/prisma";

/**
 * Session-revocation lookups for the auth guards: account suspension
 * (`disabledAt`), the session epoch (`sessionEpoch`), and whether the account
 * still exists at all.
 *
 * All three answer the same question — "is this token still good?" — and none
 * can be answered in `proxy.ts`: the edge proxy does no DB access at all, and it
 * slides the auth token forward preserving every claim, so a token minted
 * before a disable (or before a password change, or before the row was deleted)
 * stays valid for the whole idle window and no claim can revoke it. The checks
 * therefore live at the Node-runtime chokepoints every request passes through:
 * `requireAuth`/`requireSuperAdmin` in lib/auth.ts, plus /api/auth/me,
 * /api/auth/ping and /api/auth/change-password (which use `getAuthFromRequest`
 * directly — a handler that does that owes the same checks by hand).
 *
 * That puts a DB read on the hot path, so it is cached. Suspension and a raised
 * epoch are both rare, but **existence is not a rare property**: knowing that an
 * id is *absent* means knowing the full set of present ids, so the snapshot
 * carries every user id rather than only the exceptional rows. See
 * `loadSnapshot` for what that costs and why the alternatives are worse.
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
  /**
   * Every user id that existed when the snapshot was taken. Unlike the two
   * collections below this one is dense, because "absent" is the answer it has
   * to support and absence can only be read off a complete list.
   */
  known: Set<number>;
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

/**
 * Bumped by every `invalidateUserStatusCache()`. A load stamps the value it
 * started under and refuses to publish its result if the stamp has moved, so a
 * query that was already in flight when an invalidation happened cannot
 * resurrect the state it read. As the call sites stand today this is equivalent
 * to checking that the load still owns `inflight`; see
 * `invalidateUserStatusCache` for the edit it is here to survive.
 */
let generation = 0;

/**
 * One relaxed query over the whole `users` table, three narrow columns.
 *
 * This used to be filtered to `disabledAt IS NOT NULL OR sessionEpoch > 0` —
 * only the exceptional rows — which is why a *deleted* account's token sailed
 * through every guard: it was in neither set, so `disabled.has(id)` was false
 * and `epochs.get(id) ?? 0` was 0, and nothing asked whether the row was still
 * there at all.
 *
 * Why the whole table is the right shape, against the two alternatives:
 *
 * - **A tombstone table** avoids loading every id, but it only records the
 *   deletions the code remembers to record. Accounts also disappear through the
 *   full restore's `deleteMany`, through `POST /api/admin/wipe`, and through
 *   direct SQL — each would have to opt in, and the day one forgets is the day
 *   the hole is back. A snapshot *derived from the table* is right however the
 *   row went away, and needs neither a migration nor pruning.
 * - **A `findUnique` on every authenticated request** is always right but puts a
 *   DB round-trip on the hot path, which is the cost this cache exists to avoid:
 *   measured ~0.7ms median per call, so ~7ms of database time per second at a
 *   modest 10 req/s, against ~8ms once per 15s here.
 *
 * Cost of the relaxed query, measured on this schema (warm, median of 5):
 * 501 rows 4.6ms, 5,001 rows 7.8ms, 50,001 rows 89ms. `User` holds *staff*
 * accounts — learners are `Student`, keyed by email — so a real instance sits in
 * the hundreds; 5,000 is already a generous ceiling, and it costs ~8ms once per
 * TTL per process with concurrent callers de-duplicated onto it. At ten times
 * that ceiling it is ~89ms per 15s, which is still not on a request.
 */
async function loadSnapshot(): Promise<StatusSnapshot> {
  const rows = await prisma.user.findMany({
    select: { id: true, disabledAt: true, sessionEpoch: true },
  });
  const known = new Set<number>();
  const disabled = new Set<number>();
  const epochs = new Map<number, number>();
  for (const row of rows) {
    known.add(row.id);
    if (row.disabledAt !== null) disabled.add(row.id);
    if (row.sessionEpoch > 0) epochs.set(row.id, row.sessionEpoch);
  }
  return { known, disabled, epochs };
}

async function getSnapshot(): Promise<StatusSnapshot> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.snapshot;
  // Collapse a burst of concurrent requests onto one query.
  if (!inflight) {
    // Stamped *before* the query is issued, so it records the state of the
    // world this load is about to read. Anything that invalidates after this
    // line moves `generation` past the stamp and the result below is dropped.
    const startedAt = generation;
    const load = loadSnapshot()
      .then((snapshot) => {
        // Publish only if nothing was invalidated while we were waiting. A
        // superseded load still *resolves* — its caller asked before the
        // invalidation and gets the answer that was current when it asked —
        // it just doesn't get to install that answer as the cached one.
        if (generation === startedAt) cache = { snapshot, at: Date.now() };
        return snapshot;
      })
      .finally(() => {
        // Only clear the slot if it is still ours. Once `invalidateUserStatusCache`
        // drops `inflight`, a newer load can be occupying it, and an unguarded
        // `inflight = null` here would evict that live load — the next caller
        // would start a third redundant query instead of joining the second.
        if (inflight === load) inflight = null;
      });
    inflight = load;
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
 * Has the account this token belongs to been deleted?
 *
 * A deleted row cannot carry a raised `sessionEpoch` or a `disabledAt` — there
 * is nothing left to carry it — so deletion is the one revocation the other two
 * predicates structurally cannot see, and without this check a deleted user's
 * token kept its role and full access until the 8h absolute cap.
 *
 * Absence from the snapshot is a *filter, not the verdict*: the snapshot is up
 * to TTL_MS old, so it also lacks an account created in the last 15 seconds, and
 * rejecting those would sign out every freshly created (or freshly restored)
 * account for the rest of the window — including the one the setup wizard just
 * made. So an absent id is confirmed with a single primary-key lookup before the
 * session is killed. That keeps the common path free of any query, and the
 * confirming read happens only for a token whose account is genuinely gone (its
 * next request is a 401 that logs the client out) or was made moments ago.
 *
 * **Fails open** (reports `false`, i.e. "still there") on a DB error, for the
 * same reason as `isUserDisabled` above: the instinct here is to fail closed —
 * an unknown account sounds like one to reject — and that instinct is wrong,
 * because a transient DB blip would then sign out every session in the instance
 * at once. Availability of the whole instance outweighs a deleted account
 * surviving the few seconds until the database answers again.
 */
export async function isUserDeleted(userId: number): Promise<boolean> {
  try {
    const { known } = await getSnapshot();
    if (known.has(userId)) return false;
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return row === null;
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
 * toggle, after a session-epoch bump, and after a user is deleted — the delete
 * cannot bump an epoch (the row is gone), so invalidating this snapshot is the
 * only lever it has.
 *
 * `cache = null` alone was not enough: it says nothing about a query that is
 * **already in flight**. A load issued before the mutating route committed can
 * resolve after this call, and it used to assign `cache` unconditionally — with
 * a *fresh* `at` — handing the pre-commit snapshot a full new TTL_MS of life.
 * That silently deferred the revocation by up to the TTL, which is precisely
 * what the comment above `TTL_MS` promises cannot happen ("the route that flips
 * the flag invalidates its own cache immediately"). It needs a concurrent
 * request landing in the sliver between the handler's own guard and its commit,
 * so it is narrow, but the window is real and the consequence is a suspended
 * (or deleted) account keeping its session.
 *
 * `inflight = null` is what fixes that, and it carries a **precondition worth
 * not breaking**: it works because every call site invalidates *after* its
 * write has been awaited, so a load started afterwards is reading committed
 * state. Invalidating from inside a transaction callback — before the commit
 * lands — would reintroduce this exact bug with all three lines still in place.
 *
 * Note what `inflight = null` does *not* do, because this is the part that
 * looks like it should be enough and isn't: it cancels nothing. The `.then`
 * closure created back in `getSnapshot` is already attached to a promise that
 * will still settle, and it will still run. Dropping the reference only stops
 * *new* callers joining it. What stops it writing `cache` is the guard inside
 * that closure.
 *
 * That guard is `generation`, and it is **defence in depth rather than strictly
 * necessary**. Given that this function nulls `inflight`, checking
 * `generation === startedAt` is exactly equivalent to checking
 * `inflight === load`: with no invalidation only one load is ever live, and
 * with one, `inflight` has been nulled so both guards fail together. The
 * counter earns its place by surviving the edit that removes `inflight = null`
 * from this function — a realistic future "simplification", since that line
 * looks redundant next to `cache = null`. Without the counter that edit
 * silently restores the stale publish; with it, only the extra query comes
 * back.
 *
 * The cost of nulling `inflight` is one extra query whenever a load happened to
 * be in flight at invalidation time. Invalidations are rare and mostly
 * administrative (disable/enable, admin password reset, delete, restore) but
 * **not exclusively** — an ordinary user changing their own password bumps
 * their session epoch and invalidates too. That is still a handful of queries
 * against a revocation that would otherwise be up to 15 seconds late. It does
 * mean N invalidations can cost up to N queries, so a bulk path should
 * invalidate **once at the end** rather than per row; the backup restore
 * already does exactly that, after its transaction closes.
 *
 * One honest consequence for the fail-open convention the predicates document:
 * a superseded load still resolves normally, but a caller arriving after an
 * invalidation now joins a *new* load, so it can see a DB error the old code
 * would have shielded it from by handing it the in-flight load that succeeded.
 * That costs nothing — all three predicates catch and fail open to `false`, the
 * permissive answer — but it is a new path, not an unchanged one.
 */
export function invalidateUserStatusCache(): void {
  cache = null;
  generation += 1;
  inflight = null;
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
