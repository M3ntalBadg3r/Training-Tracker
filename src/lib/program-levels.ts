/**
 * The partner-program geography vocabulary: the stored requirement levels
 * (`ProgramLevel`), how a multi-country level counts a requirement
 * (`ProgramData.aggregation`), and the view scopes the dashboards and
 * Compliance Planning select.
 *
 * **Zero imports, on purpose** — it is read by client components, route
 * handlers, the import and the backup restore alike, and the level lists used
 * to be restated in three admin files plus two write paths. Anything added
 * here must keep it import-free (the same rule as `roles.ts` / `csp.ts`).
 *
 * Scope → requirement level is one-to-one: each view plans and reports against
 * only its own level's requirements. "By Region" used to be derived from the
 * Country-level rows pooled across the region; it now reads Region rows only.
 */

export const REQ_LEVELS = ["Country", "Region", "CountrySet", "Theatre", "Global"] as const;
export type ReqLevel = (typeof REQ_LEVELS)[number];

export const LEVEL_LABELS: Record<ReqLevel, string> = {
  Country: "Country",
  Region: "Region",
  CountrySet: "Country Set",
  Theatre: "Theatre",
  Global: "Global",
};

export function isReqLevel(v: unknown): v is ReqLevel {
  return typeof v === "string" && (REQ_LEVELS as readonly string[]).includes(v);
}

/** A level whose population spans several countries, so it carries a count mode. */
export function isMultiCountryLevel(level: string): level is "Region" | "CountrySet" {
  return level === "Region" || level === "CountrySet";
}

export const AGGREGATIONS = ["total", "eachCountry"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const AGGREGATION_LABELS: Record<Aggregation, string> = {
  total: "Total across the area",
  eachCountry: "In each country",
};

/** Short form for table cells and import/export ("Total" / "Each country"). */
export const AGGREGATION_SHORT_LABELS: Record<Aggregation, string> = {
  total: "Total",
  eachCountry: "Each country",
};

export function isAggregation(v: unknown): v is Aggregation {
  return typeof v === "string" && (AGGREGATIONS as readonly string[]).includes(v);
}

/**
 * The single rule every write and restore path applies: `"eachCountry"` only
 * when the level spans several countries AND the value asks for it; otherwise
 * `"total"`. Two DB CHECK constraints enforce the same thing, so a value that
 * skipped this would fail the write rather than be stored.
 */
export function normaliseAggregation(level: string, raw: unknown): Aggregation {
  return isMultiCountryLevel(level) && raw === "eachCountry" ? "eachCountry" : "total";
}

export const SCOPE_LEVELS = ["global", "theatre", "region", "countrySet", "country"] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** Validate a user-editable value (query string, request) — never trust it. */
export function parseScopeLevel(v: string | null | undefined): ScopeLevel | null {
  return typeof v === "string" && (SCOPE_LEVELS as readonly string[]).includes(v) ? (v as ScopeLevel) : null;
}

export const SCOPE_TO_REQ_LEVEL: Record<ScopeLevel, ReqLevel> = {
  global: "Global",
  theatre: "Theatre",
  region: "Region",
  countrySet: "CountrySet",
  country: "Country",
};

export const SCOPE_LEVEL_LABELS: Record<ScopeLevel, string> = {
  global: "Global",
  theatre: "By Theatre",
  region: "By Region",
  countrySet: "By Country Set",
  country: "By Country",
};

/** The noun for a scope's value, for prompts like "Select a country set". */
export const SCOPE_VALUE_NOUN: Record<Exclude<ScopeLevel, "global">, string> = {
  theatre: "theatre",
  region: "region",
  countrySet: "country set",
  country: "country",
};

/** Whether a program whose rows carry `levels` offers the given view scope. */
export function scopeLevelOffered(level: ScopeLevel, levels: readonly string[]): boolean {
  return levels.includes(SCOPE_TO_REQ_LEVEL[level]);
}

/** One country's figure for an "each country" requirement. */
export interface CountryBreakdownRow {
  country: string;
  count: number;
  compliant: boolean;
}
