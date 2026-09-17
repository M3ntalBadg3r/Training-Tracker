/**
 * Turn the offering API's three country lists into one mutually exclusive set of
 * map bands.
 *
 * The API's bands deliberately overlap: Offshore is every country worldwide
 * minus Onshore, which makes it a *superset* of Nearshore
 * (`src/lib/offering-compliance.ts`). A choropleth cannot give one country two
 * fills, so the picture splits Offshore into the part inside the theatre
 * (Nearshore) and the part outside it — and the legend says so, because a map
 * that showed the overlap silently would misstate the model rather than simplify
 * it.
 *
 * Exclusivity is built here rather than inherited from the API. The three lists
 * are already disjoint in that order today, but a country is assigned to the
 * first band it appears in and skipped thereafter, so the picture stays a
 * partition even if the server's definitions ever move.
 */
import { ISO_ALPHA2_PATTERN } from "@/lib/iso-countries";
import type { GeoMapDatum } from "@/components/geo/GeoMap";

/** The three fills. `rest` is Offshore outside the theatre. */
export type OfferingBand = "onshore" | "nearshore" | "rest";

/** Just the fields of `GeoOut` this needs; keeps the helper testable. */
export interface OfferingBandInput {
  onshoreCountries: string[];
  nearshoreCountries: string[];
  offshoreCountries: string[];
}

/** Just the fields of `RegionDataRow` this needs. */
export interface CountryIsoRow {
  country: string;
  isoCode: string | null;
}

export interface OfferingBandMap {
  /** One datum per drawable country, onshore first so it wins an ISO collision. */
  data: GeoMapDatum[];
  /** In-scope countries the map cannot place, for `GeoMap`'s own notice. */
  unmapped: string[];
  /**
   * Holders sitting in those unmapped countries — always 0 for the band map,
   * which is why this is not simply `unmapped.length`.
   *
   * A band is set membership, so naming the country IS the whole datum and
   * dropping its shape loses nothing countable. A density country carries a
   * **number**, and that number would otherwise appear nowhere on screen: the
   * shades would sum to less than the table's figure with nothing saying by how
   * much. `GeoMap`'s own notice cannot report it — it is shared and deliberately
   * knows nothing about values — so the caller states it. "Stated, never
   * dropped" is only half-honoured by a count that is itself dropped.
   */
  omittedHolders: number;
}

/**
 * `RegionData.isoCode` is operator-entered and rows can predate the database
 * CHECK, so a stored value is untrusted text until it matches the pattern. Case
 * is normalised — ISO 3166-1 alpha-2 is defined as uppercase, so `gb` is the
 * same code written badly rather than a different one — but nothing else is
 * guessed at: anything that still fails the test is reported as unmapped.
 */
function isoIndex(rows: CountryIsoRow[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    const code = (row.isoCode ?? "").trim().toUpperCase();
    if (ISO_ALPHA2_PATTERN.test(code)) index.set(row.country, code);
  }
  return index;
}

export function buildOfferingBandMap(
  geo: OfferingBandInput,
  rows: CountryIsoRow[]
): OfferingBandMap {
  const index = isoIndex(rows);
  const assigned = new Set<string>();
  const data: GeoMapDatum[] = [];
  const unmapped: string[] = [];

  const add = (countries: string[], band: OfferingBand) => {
    for (const country of countries) {
      if (assigned.has(country)) continue;
      assigned.add(country);
      const iso = index.get(country);
      // A country with no usable code is stated, never dropped — the whole
      // point of the isoCode column is that the join fails loudly.
      if (!iso) {
        unmapped.push(country);
        continue;
      }
      // Several countries may legitimately share one code ("England" and
      // "Scotland", both GB). GeoMap folds them onto the one shape and keeps
      // both names; the first band listed wins, which is why onshore is added
      // first — the most local claim on a shape is the truest one to draw.
      data.push({ iso, labels: [country], value: null, band });
    }
  };

  add(geo.onshoreCountries, "onshore");
  add(geo.nearshoreCountries, "nearshore");
  add(geo.offshoreCountries, "rest");

  unmapped.sort((a, b) => a.localeCompare(b));
  // A band carries no quantity, so nothing countable is lost here.
  return { data, unmapped, omittedHolders: 0 };
}

/**
 * Turn one requirement's per-country holder counts into a sequential-mode map.
 *
 * The whole job here is deciding, per country, between **0** and **no data** —
 * which `holders` alone cannot tell you, because the server omits a country
 * with no holders rather than sending a zero. The answer comes from the geo
 * lists instead:
 *
 *  - **In scope** is `onshoreCountries ∪ offshoreCountries`, which is precisely
 *    the set `computeOfferingCountryBreakdown` ran its query over. A country in
 *    it that `holders` does not mention was counted and came back empty, so it
 *    is a genuine **0** and is drawn at the palest step of the ramp.
 *  - Everything else — every country the query never asked about, and every
 *    shape the atlas has that Region Data does not list — gets no datum at all
 *    and `GeoMap` paints it neutral grey, off the scale.
 *
 * Nearshore is deliberately *not* added to the in-scope set even though the
 * table has a Nearshore column: it is a subset of Offshore, so it is already
 * covered, and widening this set beyond what the server queried is exactly how
 * a country that was never counted would come to read as "nobody here".
 *
 * A holder count for a country outside that set cannot arise today (the query
 * filters on the same list) but is carried through rather than dropped if it
 * ever does — a real number silently discarded is the failure this whole layer
 * exists to avoid.
 *
 * On ISO collisions: several countries may share a code, and `GeoMap` sums
 * their values. That is correct here and cannot double-count a person, because
 * these keys are `Student.country` — one column, one value per student — so
 * every holder is counted under exactly one country name.
 */
export function buildOfferingDensityMap(
  geo: OfferingBandInput,
  rows: CountryIsoRow[],
  holders: Record<string, number>
): OfferingBandMap {
  const index = isoIndex(rows);
  const data: GeoMapDatum[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();

  let omittedHolders = 0;

  const add = (country: string, value: number) => {
    if (seen.has(country)) return;
    seen.add(country);
    const iso = index.get(country);
    if (!iso) {
      unmapped.push(country);
      omittedHolders += value;
      return;
    }
    data.push({ iso, labels: [country], value });
  };

  // `holders` is a parsed JSON object, so a plain `holders[country]` reads
  // through the prototype chain: a country named `constructor` or `toString`
  // would yield a function, which `?? 0` does not catch. Not credible data, but
  // CLAUDE.md carries this rule for exactly this shape elsewhere.
  const held = (country: string) =>
    Object.hasOwn(holders, country) && typeof holders[country] === "number"
      ? holders[country]
      : 0;

  // Onshore first so its name leads the label when countries share a shape.
  for (const country of geo.onshoreCountries) add(country, held(country));
  for (const country of geo.offshoreCountries) add(country, held(country));
  // Anything the server counted that the geo lists somehow do not name.
  for (const country of Object.keys(holders)) add(country, held(country));

  unmapped.sort((a, b) => a.localeCompare(b));
  return { data, unmapped, omittedHolders };
}
