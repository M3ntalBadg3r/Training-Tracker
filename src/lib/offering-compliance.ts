/**
 * Offering compliance helpers.
 *
 * An offering's numbers are split into two geographies for a chosen country or
 * region:
 *   - Onshore  = the selected country (or the selected region's countries).
 *   - Offshore = the REST of that geography's theatre — every other country in
 *                the theatre, with the onshore countries removed.
 *
 * The actual holder counting reuses the Programs compliance engine
 * (`getEmailSetsByTitle` + `unionAttained`); this module only resolves the
 * onshore/offshore country lists via `RegionData.theatre`.
 */
import prisma from "@/lib/prisma";
import {
  getEmailSetsByTitle,
  unionAttained,
  countriesInRegion,
  type ComplianceScope,
} from "@/lib/program-compliance";

export type OfferingLevel = "country" | "region";

export interface OfferingGeo {
  level: OfferingLevel;
  value: string;
  /** Theatre(s) the onshore geography belongs to (via RegionData.theatre). */
  theatres: string[];
  /** Countries counted as Onshore. */
  onshoreCountries: string[];
  /** Countries counted as Offshore (theatre minus onshore). */
  offshoreCountries: string[];
  /** False when the theatre couldn't be resolved (no RegionData.theatre). */
  hasOffshore: boolean;
  /** Human-readable label for exports/headers. */
  scopeLabel: string;
}

/** All countries whose RegionData.theatre matches any of `theatres`. */
async function countriesInTheatres(theatres: string[]): Promise<string[]> {
  if (theatres.length === 0) return [];
  const rows = await prisma.regionData.findMany({
    where: { theatre: { in: theatres } },
    select: { country: true },
  });
  return rows.map((r) => r.country);
}

/**
 * Resolve the onshore/offshore country lists for a country or region selection.
 */
export async function resolveOfferingGeo(level: OfferingLevel, value: string): Promise<OfferingGeo> {
  let onshoreCountries: string[] = [];
  let theatres: string[] = [];

  if (level === "country") {
    onshoreCountries = [value];
    const rd = await prisma.regionData.findUnique({ where: { country: value }, select: { theatre: true } });
    if (rd?.theatre) theatres = [rd.theatre];
  } else {
    onshoreCountries = await countriesInRegion(value);
    // The theatre(s) the region belongs to (usually one).
    const rows = await prisma.regionData.findMany({
      where: { region: value, theatre: { not: null } },
      select: { theatre: true },
      distinct: ["theatre"],
    });
    theatres = rows.map((r) => r.theatre!).filter(Boolean);
  }

  const onshoreSet = new Set(onshoreCountries);
  const theatreCountries = await countriesInTheatres(theatres);
  const offshoreCountries = theatreCountries.filter((c) => !onshoreSet.has(c));

  return {
    level,
    value,
    theatres,
    onshoreCountries,
    offshoreCountries,
    hasOffshore: theatres.length > 0,
    scopeLabel: level === "country" ? value : `${value} (region)`,
  };
}

/** Build the onshore ComplianceScope for the geo + company filter. */
export function onshoreScope(geo: OfferingGeo, companyIds: number[] | null): ComplianceScope {
  if (geo.level === "country") return { country: geo.value, companyIds };
  return { countries: geo.onshoreCountries, companyIds };
}

/** Build the offshore ComplianceScope for the geo + company filter. */
export function offshoreScope(geo: OfferingGeo, companyIds: number[] | null): ComplianceScope {
  return { countries: geo.offshoreCountries, companyIds };
}

/** Minimal requirement shape the counting engine needs. */
export interface OfferingReqLike {
  trainingTitle: string | null;
  alternatives: { trainingTitle: string }[];
  quantityRequired: number;
}

/** Collect the unique union of primary + alternative titles across requirements. */
export function collectTitles(reqs: OfferingReqLike[]): string[] {
  const set = new Set<string>();
  for (const r of reqs) {
    if (r.trainingTitle) set.add(r.trainingTitle);
    for (const a of r.alternatives) set.add(a.trainingTitle);
  }
  return [...set];
}

/**
 * Count onshore + offshore distinct holders for every requirement in one pass.
 * Returns a map keyed by a caller-supplied id → { onshore, offshore }.
 */
export async function computeOfferingCounts(
  reqs: Array<OfferingReqLike & { id: number }>,
  geo: OfferingGeo,
  companyIds: number[] | null
): Promise<Map<number, { onshore: number; offshore: number }>> {
  const now = new Date();
  const titles = collectTitles(reqs);

  const [onshoreSets, offshoreSets] = await Promise.all([
    getEmailSetsByTitle(titles, now, onshoreScope(geo, companyIds)),
    geo.hasOffshore && geo.offshoreCountries.length > 0
      ? getEmailSetsByTitle(titles, now, offshoreScope(geo, companyIds))
      : Promise.resolve(new Map<string, Set<string>>()),
  ]);

  const result = new Map<number, { onshore: number; offshore: number }>();
  for (const r of reqs) {
    result.set(r.id, {
      onshore: unionAttained(r, onshoreSets),
      offshore: unionAttained(r, offshoreSets),
    });
  }
  return result;
}
