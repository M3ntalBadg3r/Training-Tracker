import { prisma } from "@/lib/prisma";

/**
 * Read helpers for Country Sets — custom groupings of countries that partner
 * programs report against (`ProgramLevel.CountrySet`). Global reference data,
 * never company-scoped, exactly like `RegionData`: a set holds country names
 * only, no tenant values. Admin writes live in the `api/admin/country-sets`
 * routes, not here. Server-only — imports Prisma.
 */

/** A set's member countries, sorted. `[]` for an unknown or empty set. */
export async function countriesInCountrySet(name: string): Promise<string[]> {
  if (!name) return [];
  const rows = await prisma.countrySetMember.findMany({
    where: { countrySet: { name } },
    select: { country: true },
    orderBy: { country: "asc" },
  });
  return rows.map((r: { country: string }) => r.country);
}

/**
 * Names of the sets that have at least one member, sorted — the pick-list for
 * a "By Country Set" scope. An empty set is left out for the same reason the
 * region list only carries regions that have countries: choosing it could only
 * ever show an empty report.
 */
export async function listCountrySetNames(): Promise<string[]> {
  const rows = await prisma.countrySet.findMany({
    where: { members: { some: {} } },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r: { name: string }) => r.name);
}
