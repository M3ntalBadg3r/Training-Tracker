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
  return { data, unmapped };
}
