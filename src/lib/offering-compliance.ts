/**
 * Offering compliance helpers.
 *
 * An offering's numbers are split into three geographies for a chosen country or
 * region:
 *   - Onshore   = the selected country (or the selected region's countries).
 *   - Nearshore = the REST of that geography's theatre — every other country in
 *                 the theatre, with the onshore countries removed.
 *   - Offshore  = every country WORLDWIDE, with the onshore countries removed
 *                 (a superset of Nearshore; the buckets intentionally overlap).
 *
 * The actual holder counting reuses the Programs compliance engine
 * (`getEmailSetsByTitle` + `unionAttained`); this module only resolves the
 * onshore/nearshore/offshore country lists via `RegionData`.
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
  /** Countries counted as Nearshore (rest of the theatre minus onshore). */
  nearshoreCountries: string[];
  /** Countries counted as Offshore (all countries worldwide minus onshore). */
  offshoreCountries: string[];
  /** False when the theatre couldn't be resolved (no RegionData.theatre). */
  hasNearshore: boolean;
  /** False when there are no other countries worldwide to count. */
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

/** Every country in RegionData (no theatre filter). */
async function allCountries(): Promise<string[]> {
  const rows = await prisma.regionData.findMany({ select: { country: true } });
  return rows.map((r) => r.country);
}

/**
 * Resolve the onshore/nearshore/offshore country lists for a country or region
 * selection.
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
  const [theatreCountries, worldCountries] = await Promise.all([
    countriesInTheatres(theatres),
    allCountries(),
  ]);
  const nearshoreCountries = theatreCountries.filter((c) => !onshoreSet.has(c));
  const offshoreCountries = worldCountries.filter((c) => !onshoreSet.has(c));

  return {
    level,
    value,
    theatres,
    onshoreCountries,
    nearshoreCountries,
    offshoreCountries,
    hasNearshore: theatres.length > 0,
    hasOffshore: offshoreCountries.length > 0,
    scopeLabel: level === "country" ? value : `${value} (region)`,
  };
}

/** Build the onshore ComplianceScope for the geo + company filter. */
export function onshoreScope(geo: OfferingGeo, companyIds: number[] | null): ComplianceScope {
  if (geo.level === "country") return { country: geo.value, companyIds };
  return { countries: geo.onshoreCountries, companyIds };
}

/** Build the nearshore (rest-of-theatre) ComplianceScope for the geo + company filter. */
export function nearshoreScope(geo: OfferingGeo, companyIds: number[] | null): ComplianceScope {
  return { countries: geo.nearshoreCountries, companyIds };
}

/** Build the offshore (worldwide) ComplianceScope for the geo + company filter. */
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
 * Count onshore + nearshore + offshore distinct holders for every requirement in
 * one pass. Returns a map keyed by a caller-supplied id →
 * { onshore, nearshore, offshore }.
 */
export async function computeOfferingCounts(
  reqs: Array<OfferingReqLike & { id: number }>,
  geo: OfferingGeo,
  companyIds: number[] | null
): Promise<Map<number, { onshore: number; nearshore: number; offshore: number }>> {
  const now = new Date();
  const titles = collectTitles(reqs);
  const empty = () => Promise.resolve(new Map<string, Set<string>>());

  const [onshoreSets, nearshoreSets, offshoreSets] = await Promise.all([
    getEmailSetsByTitle(titles, now, onshoreScope(geo, companyIds)),
    geo.hasNearshore && geo.nearshoreCountries.length > 0
      ? getEmailSetsByTitle(titles, now, nearshoreScope(geo, companyIds))
      : empty(),
    geo.hasOffshore && geo.offshoreCountries.length > 0
      ? getEmailSetsByTitle(titles, now, offshoreScope(geo, companyIds))
      : empty(),
  ]);

  const result = new Map<number, { onshore: number; nearshore: number; offshore: number }>();
  for (const r of reqs) {
    result.set(r.id, {
      onshore: unionAttained(r, onshoreSets),
      nearshore: unionAttained(r, nearshoreSets),
      offshore: unionAttained(r, offshoreSets),
    });
  }
  return result;
}
