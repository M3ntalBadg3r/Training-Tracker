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
  getEmailSetsByTitleAndGeo,
  unionAttained,
  unionAttainedByGeo,
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
  companyIds: number[] | null,
  /**
   * Point-in-time instant. Both functions default to their own `new Date()`,
   * which is correct when either is called alone — but the offering route calls
   * BOTH and shows their results side by side, so it passes one shared instant.
   * Without that they run in separate transactions off separate clocks, and a
   * completion expiring between the two round-trips leaves the map summing to
   * one less than the table it sits above.
   */
  asOf: Date = new Date()
): Promise<Map<number, { onshore: number; nearshore: number; offshore: number }>> {
  const now = asOf;
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

/**
 * Per-country distinct-holder counts, keyed by the app's own country name (the
 * `RegionData.country` / `Student.country` string — there is no ISO join here).
 *
 * **This is a DISTRIBUTION, never a per-country compliance verdict.** `met` is
 * decided on the Onshore set *as a whole*
 * (`req.met = onshore >= req.quantityRequired`), so three holders spread across
 * three countries satisfy a requirement of 3 that no single country meets.
 * Reading any entry here against `quantityRequired` would therefore report a
 * failure that does not exist. Hence `holdersByCountry`, and nothing named
 * "compliance".
 *
 * Countries with no holders are absent rather than present as 0 — absent means
 * "no holders in a country that WAS counted", which a consumer renders as zero,
 * while a country that was never in scope is absent for a different reason and
 * is not knowable from this record alone. The consumer decides which by
 * intersecting these keys with the geo country lists it was given; see
 * `buildOfferingDensityMap`.
 */
export type HoldersByCountry = Record<string, number>;

/**
 * Per-country holder breakdown for an offering's requirements, over the union
 * of the Onshore and Offshore country lists — i.e. every country the three
 * bands are drawn from, in one query. Returns one map per requirement id.
 *
 * Each map decomposes exactly the same numbers the Onshore/Nearshore/Offshore
 * columns show, so summing its entries over `geo.onshoreCountries` reproduces
 * `onshore` — and likewise for the other two bands, each over *its own* country
 * list. It never reconciles over the whole map, because Offshore is a superset
 * of Nearshore (see the bucketing comment in `getEmailSetsByTitleAndGeo` for
 * why the partition holds at all).
 *
 * There is deliberately **no whole-offering map alongside these.** A union over
 * every requirement's titles would not be the sum of these maps — one person
 * holding two of the offering's trainings is one person — so it would reconcile
 * against nothing on screen, which is the one thing a number beside a table has
 * to do.
 *
 * Deliberately a second function rather than an extra field on
 * `computeOfferingCounts`: the public API (`/api/public/v1/offerings`) uses that
 * one and does not need this, so it keeps its current cost and response shape.
 *
 * Counting is the shared engine (`getEmailSetsByTitleAndGeo` +
 * `unionAttainedByGeo`), so the point-in-time window, the sibling expansion and
 * the company-scope rules are inherited rather than restated here.
 */
export async function computeOfferingCountryBreakdown(
  reqs: Array<OfferingReqLike & { id: number }>,
  geo: OfferingGeo,
  companyIds: number[] | null,
  /**
   * Point-in-time instant. Both functions default to their own `new Date()`,
   * which is correct when either is called alone — but the offering route calls
   * BOTH and shows their results side by side, so it passes one shared instant.
   * Without that they run in separate transactions off separate clocks, and a
   * completion expiring between the two round-trips leaves the map summing to
   * one less than the table it sits above.
   */
  asOf: Date = new Date()
): Promise<Map<number, HoldersByCountry>> {
  const now = asOf;
  const titles = collectTitles(reqs);
  const byRequirement = new Map<number, HoldersByCountry>();
  if (titles.length === 0) return byRequirement;

  // Onshore ∪ Offshore is every country the bands can draw from (Nearshore is a
  // subset of Offshore). One bucketed query therefore serves all three — and it
  // is also exactly the set a consumer must treat as "counted", so an absent
  // country in it is a true zero.
  const countries = [...new Set([...geo.onshoreCountries, ...geo.offshoreCountries])];
  if (countries.length === 0) return byRequirement;

  const sets = await getEmailSetsByTitleAndGeo(titles, now, "country", { countries, companyIds });

  for (const r of reqs) {
    const out: HoldersByCountry = {};
    for (const row of unionAttainedByGeo(r, sets)) if (row.count > 0) out[row.bucket] = row.count;
    byRequirement.set(r.id, out);
  }
  return byRequirement;
}
