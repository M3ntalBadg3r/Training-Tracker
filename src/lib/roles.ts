/**
 * The role vocabulary and the "SuperAdmin is a superset of Admin" rule, in one
 * place.
 *
 * This existed three times over: `company-scope.ts` had named constants and the
 * two predicates, `proxy.ts` open-coded `isAdminish` as a local `const` with
 * duplicate string literals, and `auth.ts` open-coded it again as nested string
 * comparisons inside `requireAuth`. Neither of the latter two could import the
 * first, and that is the whole reason they drifted: `company-scope.ts` imports
 * Prisma, and `proxy.ts` runs in the **edge** runtime where Prisma cannot go.
 * (Same constraint that splits cron verification into a stateless proxy half
 * and a stateful handler half — see `cron-auth.ts`.)
 *
 * So this module deliberately has **no imports at all**. Anything added here
 * must keep that property, or the edge side silently loses its copy again.
 *
 * Note this covers the role *predicates* only. The path allow-list that decides
 * which routes require SuperAdmin (`SUPER_ADMIN_PREFIXES`) stays in `proxy.ts`:
 * it is edge-routing configuration rather than a shared rule, and the per-handler
 * guards it backs up are enforced independently by `scripts/check-route-guards.mjs`.
 */

export const SUPER_ADMIN_ROLE = "SuperAdmin";
export const ADMIN_ROLE = "Admin";
export const USER_ROLE = "User";

/** Every role, for validating admin-supplied input. */
export const VALID_ROLES: readonly string[] = [SUPER_ADMIN_ROLE, ADMIN_ROLE, USER_ROLE];

export function isSuperAdmin(role: string | undefined | null): boolean {
  return role === SUPER_ADMIN_ROLE;
}

/**
 * A SuperAdmin or Admin can perform admin-style operations within their scope.
 * This is the "Admin accepts SuperAdmin too" rule that `requireAuth(request,
 * "Admin")` and the proxy's `/admin` gate both depend on.
 */
export function isAdminish(role: string | undefined | null): boolean {
  return role === SUPER_ADMIN_ROLE || role === ADMIN_ROLE;
}
