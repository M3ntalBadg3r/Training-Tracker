/**
 * Helpers for resolving the set of companies a user is allowed to see, and for
 * intersecting that with a per-request "selected company" filter.
 *
 * Convention: a return value of `null` from getAuthorizedCompanyIds means
 * "no scope restriction" (SuperAdmin). An empty array `[]` means the caller
 * is scoped but has been granted access to no companies — which fails closed.
 */

import prisma from "@/lib/prisma";

export const SUPER_ADMIN_ROLE = "SuperAdmin";
export const ADMIN_ROLE = "Admin";

export function isSuperAdmin(role: string | undefined | null): boolean {
  return role === SUPER_ADMIN_ROLE;
}

/** A SuperAdmin or Admin can perform admin-style write operations within their scope. */
export function isAdminish(role: string | undefined | null): boolean {
  return role === SUPER_ADMIN_ROLE || role === ADMIN_ROLE;
}

/**
 * Look up the set of company ids a user can see.
 * Returns `null` for SuperAdmin (= unrestricted).
 */
export async function getAuthorizedCompanyIds(
  userId: number,
  role: string
): Promise<number[] | null> {
  if (isSuperAdmin(role)) return null;
  const rows = await prisma.userCompany.findMany({
    where: { userId },
    select: { companyId: true },
  });
  return rows.map((r) => r.companyId);
}

/**
 * Resolve the effective company-id filter for a request, given:
 *  - the caller's allowed companies (`null` = unrestricted)
 *  - an optional `?companyId=` query-string value
 *
 * Returns `null` when the request should see *all* allowed companies, or an
 * array of ids when it should be filtered to a subset (always intersected
 * with the allowed list). Returns `[]` when the request asked for a company
 * the caller does not have access to (caller should treat as "no results").
 */
export function resolveCompanyFilter(
  allowedCompanyIds: number[] | null,
  requestedRaw: string | null
): number[] | null {
  const requested = requestedRaw ? Number(requestedRaw) : NaN;
  const hasRequested = !Number.isNaN(requested);

  if (allowedCompanyIds === null) {
    // SuperAdmin: unrestricted unless a specific company was requested.
    return hasRequested ? [requested] : null;
  }
  if (!hasRequested) {
    // Scoped user with no specific request: see everything they're allowed to see.
    return allowedCompanyIds;
  }
  // Scoped user requesting a specific company: must be in their allow list.
  return allowedCompanyIds.includes(requested) ? [requested] : [];
}

/**
 * True if the caller can write to / target a given company id.
 * SuperAdmin: always. Others: only if the company is in their allow list.
 */
export async function canAccessCompany(
  userId: number,
  role: string,
  companyId: number
): Promise<boolean> {
  if (isSuperAdmin(role)) return true;
  const row = await prisma.userCompany.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  return !!row;
}
