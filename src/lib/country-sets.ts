import { prisma } from "@/lib/prisma";

/**
 * Read helpers for Country Sets — a partner's (Company's) own groupings of
 * countries that partner programs report against (`ProgramLevel.CountrySet`).
 *
 * **Sets are tenant data.** Each belongs to exactly one company and names are
 * unique only per company, so two companies can each own a "Set 1" holding
 * different countries. A set name therefore only ever resolves within ONE
 * company: every helper here takes the caller's resolved company scope and
 * answers nothing (`[]` / `null`) unless that scope is exactly one company.
 * Resolving across a multi-company scope would silently merge two partners'
 * same-named sets into one area — the cross-tenant bleed this rule exists to
 * prevent — so callers turn an ambiguous scope into a 400 instead (see
 * `COUNTRY_SET_SCOPE_ERROR`). Admin writes live in the `api/admin/country-sets`
 * routes, not here. Server-only — imports Prisma.
 */

/** The error a `level=countrySet` request gets when its scope is not one company. */
export const COUNTRY_SET_SCOPE_ERROR = "Select a single company to report on a Country Set";

/**
 * The single company a scope names, or null when it names none or several.
 * `null` (unrestricted, e.g. a SuperAdmin with no `?companyId=`), `[]` and any
 * multi-company array are all "not exactly one". The one definition every
 * caller uses, so the rule cannot drift between the dashboard, planning and
 * the public API.
 */
export function singleCompanyId(companyIds: number[] | null | undefined): number | null {
  return Array.isArray(companyIds) && companyIds.length === 1 ? companyIds[0] : null;
}

/**
 * A company's set's member countries, sorted. `[]` for an unknown or empty
 * set, AND for a scope that is not exactly one company — callers treat `[]` as
 * an empty, never-compliant area, so an ambiguous scope fails closed.
 */
export async function countriesInCountrySet(
  name: string,
  companyIds: number[] | null | undefined
): Promise<string[]> {
  const companyId = singleCompanyId(companyIds);
  if (!name || companyId === null) return [];
  const rows = await prisma.countrySetMember.findMany({
    where: { countrySet: { companyId, name } },
    select: { country: true },
    orderBy: { country: "asc" },
  });
  return rows.map((r: { country: string }) => r.country);
}

/**
 * Names of one company's sets that have at least one member, sorted — the
 * pick-list for a "By Country Set" scope. `[]` unless the scope is exactly one
 * company, so an ambiguous scope never offers a picker (and never lists another
 * company's set names). An empty set is left out for the same reason the region
 * list only carries regions that have countries.
 */
export async function listCountrySetNames(companyIds: number[] | null | undefined): Promise<string[]> {
  const companyId = singleCompanyId(companyIds);
  if (companyId === null) return [];
  const rows = await prisma.countrySet.findMany({
    where: { companyId, members: { some: {} } },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r: { name: string }) => r.name);
}
