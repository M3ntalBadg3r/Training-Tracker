export type GroupByMode = "theatre" | "region" | "country";

export interface GeoFields {
  theatre?: string | null;
  region?: string | null;
  country?: string | null;
}

/**
 * "This country has no region defined." The canonical stored form is an empty
 * string, but the literal "Unknown" is still recognised: the student import
 * used to write that word into RegionData for every country it did not know,
 * and an archive restored from before the `20260917000000_blank_unknown_region`
 * migration can carry it back in.
 */
export const isUnknownRegion = (region: string | null | undefined): boolean => {
  if (!region) return true;
  const v = region.trim().toLowerCase();
  return v === "" || v === "unknown";
};

/**
 * Placeholder texts that mean "no region", recognised on the DISPLAY side only.
 * Deliberately wider than `isUnknownRegion` above, which decides *bucketing*:
 * hiding a placeholder word in a table cell is safe, whereas folding one into
 * the theatre bucket would silently change report totals for anyone using it as
 * a real region name.
 */
const DISPLAY_PLACEHOLDER_REGIONS = new Set(["", "unknown", "not applicable"]);

/**
 * The region as it should be shown to a user: the stored value, or an empty
 * string when no region is defined. Display sites render that as an empty
 * cell/field rather than a placeholder word.
 */
export function displayRegion(region: string | null | undefined): string {
  const value = (region ?? "").trim();
  return DISPLAY_PLACEHOLDER_REGIONS.has(value.toLowerCase()) ? "" : value;
}

/**
 * Resolve the canonical group-by bucket for a row given the mode.
 * Hierarchy: country rolls up to region, region rolls up to theatre.
 * If region is missing or 'unknown', region-mode falls back to theatre.
 * If country is missing, country-mode falls back to region (then theatre).
 */
export function resolveBucket(row: GeoFields, mode: GroupByMode): string {
  const theatre = (row.theatre || "").trim();
  const region = (row.region || "").trim();
  const country = (row.country || "").trim();

  if (mode === "country") {
    if (country) return country;
    if (!isUnknownRegion(region)) return region;
    return theatre || "Unassigned";
  }
  if (mode === "region") {
    if (!isUnknownRegion(region)) return region;
    return theatre || "Unassigned";
  }
  return theatre || "Unassigned";
}

export interface Group<T> {
  key: string;
  rows: T[];
}

export function groupRows<T extends GeoFields>(rows: T[], mode: GroupByMode): Group<T>[] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = resolveBucket(row, mode);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return Array.from(map.entries())
    .map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export const GROUP_BY_LABEL: Record<GroupByMode, string> = {
  theatre: "Theatre",
  region: "Region",
  country: "Country",
};
